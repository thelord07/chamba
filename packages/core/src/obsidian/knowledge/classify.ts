/**
 * obsidian/knowledge/classify.ts — backfill classification of unclassified notes.
 *
 * Functions:
 *   - listUnclassified  — paginate notes without valid tema/ tags
 *   - classifyPlan      — compute diff (dryRun, no writes)
 *   - classifyApply     — apply the classification (writes files)
 *
 * Constraints:
 *   - ≤ 50 entries per classifyApply call
 *   - Cuerpo (body) byte-for-byte intact (upsertNoteMetadata)
 *   - Only writes the keys specified in each entry
 *   - Existing non-tema/ tags are preserved; tema/ tags are replaced
 *   - No derived paths, no paths outside vault, no path traversal (..)
 *
 * Pure TypeScript — no `node:` imports, no external dependencies.
 */

import type { DirEntry, FilesystemPort } from '../../ports/filesystem.js';
import { isTaskEvidencePath } from '../../tasks/evidence-paths.js';
import { isDerivedPathPattern } from './derived-path.js';
import type { NoteType } from './note-metadata.js';
import { readNoteMetadata, upsertNoteMetadata } from './note-metadata.js';
import { buildProvenance } from './provenance.js';
import { parseVocabulary, resolveTopic } from './vocabulary.js';

/**
 * D-Q4 (CHAMBA-021 §9, owner decision): provenance inputs for `classifyPlan`/
 * `classifyApply`. `author` is resolved by the caller (mcp's `resolveAuthor`);
 * omit it to skip `author`/`clasificado_por` entirely.
 */
export interface ClassifyProvenanceOpts {
  author?: string;
  /** chamba/mcp package version. */
  version: string;
  /** Current time as ISO string (caller reads `services.clock`). */
  nowIso: string;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface UnclassifiedItem {
  path: string;
  title: string;
  /** First paragraph of the note body, ≤ 300 chars. */
  firstParagraph: string;
}

export interface ListUnclassifiedResult {
  items: UnclassifiedItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ClassifyEntry {
  /** Vault-relative path. */
  path: string;
  /** Topics (paths or aliases); resolved via vocabulary. */
  temas: string[];
  summary?: string;
  keywords?: string[];
  type?: NoteType;
  workItem?: string;
}

export interface ClassifyDiff {
  path: string;
  before: string;
  after: string;
}

export interface ClassifyPlanResult {
  diffs: ClassifyDiff[];
  /** Entries that failed validation (unknown path, derived, etc.) */
  rejected: Array<{ path: string; reason: string }>;
}

export interface ClassifyApplyResult {
  written: string[];
  rejected: Array<{ path: string; reason: string }>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_ENTRIES = 50;
const FIRST_PARA_MAX = 300;
const VOCAB_REL_PATH = 'temas/VOCABULARIO.md';

const SKIP_DIRS = new Set([
  'memory',
  '.trash',
  '.obsidian',
  'temas',
  'node_modules',
  '.git',
  '.chamba-sync',
]);

// ─── listUnclassified ─────────────────────────────────────────────────────────

/**
 * Return paginated list of notes that have no valid `tema/` tag in the vocabulary.
 * If no vocabulary is present, all notes are "unclassified".
 */
export async function listUnclassified(
  fs: FilesystemPort,
  vaultDir: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<ListUnclassifiedResult> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.max(1, opts.pageSize ?? 50);

  // Load vocabulary (optional)
  const vocabulary = await loadVocabulary(fs, vaultDir);

  // Scan all notes
  const allNotes = await scanAllNotes(fs, vaultDir);

  // Filter unclassified
  const unclassified: UnclassifiedItem[] = [];

  for (const { relPath, content } of allNotes) {
    const meta = readNoteMetadata(content, relPath);

    // Check if note has any valid tema/ tag
    let hasValidTema = false;
    if (vocabulary !== null) {
      for (const tag of meta.tags) {
        if (tag.startsWith('tema/')) {
          const slug = tag.slice('tema/'.length);
          if (vocabulary.nodes.has(slug)) {
            hasValidTema = true;
            break;
          }
        }
      }
    }

    if (!hasValidTema) {
      unclassified.push({
        path: relPath,
        title: meta.title,
        firstParagraph: extractFirstParagraph(content, FIRST_PARA_MAX),
      });
    }
  }

  // Sort deterministically by path
  unclassified.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const total = unclassified.length;
  const offset = (page - 1) * pageSize;
  const items = unclassified.slice(offset, offset + pageSize);

  return { items, total, page, pageSize };
}

// ─── classifyPlan ─────────────────────────────────────────────────────────────

/**
 * Compute classification diffs without writing anything (dryRun).
 * Returns diffs (before/after frontmatter text) and rejected entries.
 */
export async function classifyPlan(
  fs: FilesystemPort,
  vaultDir: string,
  entries: ClassifyEntry[],
  provenanceOpts?: ClassifyProvenanceOpts,
): Promise<ClassifyPlanResult> {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(
      `classifyPlan: máximo ${MAX_ENTRIES} entradas por llamada (recibidas ${entries.length}).`,
    );
  }

  const vocabulary = await loadVocabulary(fs, vaultDir);
  const diffs: ClassifyDiff[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];

  for (const entry of entries) {
    const validationError = validateEntryPath(vaultDir, entry.path);
    if (validationError) {
      rejected.push({ path: entry.path, reason: validationError });
      continue;
    }

    const absPath = joinPath(vaultDir, entry.path);
    let content: string;
    try {
      content = await fs.readFile(absPath);
    } catch {
      rejected.push({ path: entry.path, reason: `Archivo no encontrado: ${entry.path}` });
      continue;
    }

    const meta = readNoteMetadata(content, entry.path);
    const patch = buildPatch(entry, meta, vocabulary, provenanceOpts);
    const updated = upsertNoteMetadata(content, patch);

    // Extract frontmatter portions for the diff
    const beforeFm = extractFrontmatter(content);
    const afterFm = extractFrontmatter(updated);

    diffs.push({ path: entry.path, before: beforeFm, after: afterFm });
  }

  return { diffs, rejected };
}

// ─── classifyApply ────────────────────────────────────────────────────────────

/**
 * Apply classification entries to the vault.
 * Validates entries, applies frontmatter patches (body intact), writes files.
 */
export async function classifyApply(
  fs: FilesystemPort,
  vaultDir: string,
  entries: ClassifyEntry[],
  provenanceOpts?: ClassifyProvenanceOpts,
): Promise<ClassifyApplyResult> {
  if (entries.length > MAX_ENTRIES) {
    throw new Error(
      `classifyApply: máximo ${MAX_ENTRIES} entradas por llamada (recibidas ${entries.length}).`,
    );
  }

  const vocabulary = await loadVocabulary(fs, vaultDir);
  const written: string[] = [];
  const rejected: Array<{ path: string; reason: string }> = [];

  for (const entry of entries) {
    const validationError = validateEntryPath(vaultDir, entry.path);
    if (validationError) {
      rejected.push({ path: entry.path, reason: validationError });
      continue;
    }

    const absPath = joinPath(vaultDir, entry.path);
    let content: string;
    try {
      content = await fs.readFile(absPath);
    } catch {
      rejected.push({ path: entry.path, reason: `Archivo no encontrado: ${entry.path}` });
      continue;
    }

    const meta = readNoteMetadata(content, entry.path);
    const patch = buildPatch(entry, meta, vocabulary, provenanceOpts);
    const updated = upsertNoteMetadata(content, patch);

    await fs.writeFile(absPath, updated);
    written.push(entry.path);
  }

  return { written, rejected };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateEntryPath(_vaultDir: string, relPath: string): string | null {
  // No path traversal
  if (relPath.includes('..')) {
    return `Path traversal no permitido: ${relPath}`;
  }
  // No absolute paths
  if (relPath.startsWith('/') || relPath.startsWith('\\')) {
    return `Se esperaba ruta relativa al vault: ${relPath}`;
  }
  // Not a derived path
  if (isDerivedPathPattern(relPath)) {
    return `No se puede clasificar un archivo derivado: ${relPath}`;
  }
  // M3: reject paths under temas/ (vocabulary files are not classifiable notes)
  const topDir = (relPath.split('/')[0] ?? '').toLowerCase();
  if (topDir === 'temas') {
    return `No se puede clasificar un archivo en temas/: ${relPath}`;
  }
  return null;
}

function buildPatch(
  entry: ClassifyEntry,
  meta: ReturnType<typeof readNoteMetadata>,
  vocabulary: ReturnType<typeof parseVocabulary>['vocabulary'] | null,
  provenanceOpts?: ClassifyProvenanceOpts,
): Parameters<typeof upsertNoteMetadata>[1] {
  // Resolve temas
  const resolvedTemas: string[] = [];
  const temasPropuestosFromEntry: string[] = [];

  for (const tema of entry.temas) {
    if (vocabulary === null) {
      // No vocabulary — all go to temas_propuestos
      temasPropuestosFromEntry.push(tema);
    } else {
      const result = resolveTopic(vocabulary, tema);
      if ('path' in result) {
        resolvedTemas.push(result.path);
      } else {
        temasPropuestosFromEntry.push(tema);
      }
    }
  }

  // Build new tags: keep non-tema/ existing tags + new tema/ tags
  const existingNonTemaTags = meta.tags.filter((t) => !t.startsWith('tema/'));
  const newTemaTags = [...new Set(resolvedTemas)].map((p) => `tema/${p}`);
  const newTags = [...existingNonTemaTags, ...newTemaTags];

  // Build temas_propuestos: entry's unknown temas (keep existing ones too)
  const existingPropuestos = meta.temas_propuestos;
  const combinedPropuestos = [...new Set([...existingPropuestos, ...temasPropuestosFromEntry])];

  const patch: Parameters<typeof upsertNoteMetadata>[1] = {
    tags: newTags,
    temas_propuestos: combinedPropuestos,
  };

  if (entry.summary !== undefined) patch.summary = entry.summary;
  if (entry.keywords !== undefined) patch.keywords = entry.keywords;
  if (entry.type !== undefined) patch.type = entry.type;
  if (entry.workItem !== undefined) patch.work_item = entry.workItem;

  // ── D-Q4 (CHAMBA-021 §9, owner decision) ──────────────────────────────────
  if (provenanceOpts) {
    const provenance = buildProvenance({
      author: provenanceOpts.author,
      tool: 'classify',
      version: provenanceOpts.version,
      now: new Date(provenanceOpts.nowIso),
    });

    if (meta.source === 'chamba') {
      // Chamba note: fill missing author/agent/written_at, always re-flag as propuesto.
      if (meta.author === undefined && provenance.author !== undefined) {
        patch.author = provenance.author;
      }
      if (meta.agent === undefined) patch.agent = provenance.agent;
      if (meta.written_at === undefined) patch.written_at = provenance.written_at;
      patch.estado = 'propuesto';
    } else {
      // Human note: NEVER touch author/written_at/estado. Only add-only
      // `clasificado_por` + `agent: chamba/classify@<ver>`.
      if (meta.clasificado_por === undefined && provenance.author !== undefined) {
        patch.clasificado_por = provenance.author;
      }
      if (meta.agent === undefined) patch.agent = provenance.agent;
    }
  }

  return patch;
}

function extractFrontmatter(content: string): string {
  const lines = content.split('\n');
  if ((lines[0] ?? '').replace(/\r$/, '') !== '---') return '';

  const closeIdx = lines.findIndex((l, i) => i > 0 && l.replace(/\r$/, '') === '---');
  if (closeIdx === -1) return '';

  return lines.slice(0, closeIdx + 1).join('\n');
}

function extractFirstParagraph(content: string, maxLength: number): string {
  const lines = content.split('\n');
  let inFrontmatter = false;
  let inParagraph = false;
  const paragraphLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]?.replace(/\r$/, '') ?? '';

    // Handle frontmatter
    if (i === 0 && line === '---') {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter) {
      if (line === '---') {
        inFrontmatter = false;
      }
      continue;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith('#')) {
      if (inParagraph) break;
      continue;
    }
    if (trimmed === '') {
      if (inParagraph) break;
      continue;
    }
    inParagraph = true;
    paragraphLines.push(trimmed);
  }

  if (paragraphLines.length === 0) return '';
  const joined = paragraphLines.join(' ');
  return joined.length > maxLength ? joined.slice(0, maxLength) : joined;
}

function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/');
}

async function loadVocabulary(
  fs: FilesystemPort,
  vaultDir: string,
): Promise<ReturnType<typeof parseVocabulary>['vocabulary'] | null> {
  const absPath = joinPath(vaultDir, VOCAB_REL_PATH);
  try {
    if (!(await fs.exists(absPath))) return null;
    const content = await fs.readFile(absPath);
    return parseVocabulary(content).vocabulary;
  } catch {
    return null;
  }
}

async function scanAllNotes(
  fs: FilesystemPort,
  vaultDir: string,
): Promise<Array<{ relPath: string; content: string }>> {
  const results: Array<{ relPath: string; content: string }> = [];
  await scanRecursive(fs, vaultDir, '', results);
  return results;
}

async function scanRecursive(
  fs: FilesystemPort,
  absDir: string,
  relPrefix: string,
  results: Array<{ relPath: string; content: string }>,
): Promise<void> {
  let entries: DirEntry[];
  try {
    entries = await fs.readDir(absDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const name = entry.name;
    const relPath = relPrefix === '' ? name : `${relPrefix}/${name}`;

    if (entry.isDirectory) {
      const topPart = relPath.split('/')[0] ?? '';
      if (SKIP_DIRS.has(topPart.toLowerCase())) continue;
      if (name.startsWith('.')) continue;
      if (isTaskEvidencePath(relPath)) continue; // B8: evidence subtree, never a knowledge note
      await scanRecursive(fs, `${absDir}/${name}`, relPath, results);
    } else if (entry.isFile && name.endsWith('.md')) {
      if (name === 'INDEX.md') continue;
      if (isDerivedPathPattern(relPath)) continue;
      try {
        const content = await fs.readFile(`${absDir}/${name}`);
        results.push({ relPath, content });
      } catch {
        // ignore
      }
    }
  }
}
