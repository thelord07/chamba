/**
 * obsidian/knowledge/vault-notes.ts — shared vault note-scanning utilities.
 *
 * `loadGraphNotes` and `loadVocabulary` are used by both VaultReindexer and
 * ContextBuilder (map mode) so they always scan the exact same note set.
 *
 * Rules (identical to the original VaultReindexer behaviour):
 *  - Skip: memory, .trash, .obsidian, temas, node_modules, .git, .chamba-sync
 *  - Skip dotdirs (directory names starting with `.`)
 *  - Exclude INDEX.md files (derived or manual)
 *  - Exclude Windows-invalid filenames
 *  - Read at most MAX_READ_CHARS string chars per note (frontmatter + partial body)
 *
 * Pure TypeScript: no `node:` imports, all IO through FilesystemPort.
 */

import type { FilesystemPort } from '../../ports/filesystem.js';
import { isTaskEvidencePath } from '../../tasks/evidence-paths.js';
import { isInvalidPath } from '../../util/local-path.js';
import type { GraphNote } from './knowledge-graph.js';
import { readNoteMetadata } from './note-metadata.js';
import type { Vocabulary, VocabularyError } from './vocabulary.js';
import { parseVocabulary } from './vocabulary.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum string length to parse per note (applies to frontmatter + partial body). */
export const MAX_READ_CHARS = 8192;

/** Directories to skip during vault note scanning (at any depth level). */
export const VAULT_SKIP_DIRS = new Set([
  'memory',
  '.trash',
  '.obsidian',
  'temas',
  'node_modules',
  '.git',
  '.chamba-sync',
]);

/** Vault-relative path of the vocabulary file. */
export const VAULT_VOCAB_PATH = 'temas/VOCABULARIO.md';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan `vaultDir` and return all notes as `GraphNote[]` with frontmatter parsed.
 *
 * Uses the same scanning rules as `VaultReindexer` so both see the same note set:
 * skips derived dirs, INDEX.md files, dotdirs, and Windows-invalid filenames.
 */
export async function loadGraphNotes(fs: FilesystemPort, vaultDir: string): Promise<GraphNote[]> {
  const relPaths = await scanNotePaths(fs, vaultDir, '');
  const notes: GraphNote[] = [];
  for (const relPath of relPaths) {
    const absPath = joinVaultPath(vaultDir, relPath);
    try {
      const raw = await fs.readFile(absPath);
      const content = raw.length > MAX_READ_CHARS ? raw.slice(0, MAX_READ_CHARS) : raw;
      const metadata = readNoteMetadata(content, relPath);
      notes.push({ path: relPath, metadata });
    } catch {
      // Unreadable file — skip silently
    }
  }
  return notes;
}

export interface LoadVocabularyResult {
  vocabulary: Vocabulary | null;
  errors: VocabularyError[];
}

/**
 * Read and parse the vault vocabulary from `temas/VOCABULARIO.md`.
 * Returns `{ vocabulary: null, errors: [] }` if the file does not exist.
 */
export async function loadVocabulary(
  fs: FilesystemPort,
  vaultDir: string,
): Promise<LoadVocabularyResult> {
  const absPath = joinVaultPath(vaultDir, VAULT_VOCAB_PATH);
  const errors: VocabularyError[] = [];
  if (!(await fs.exists(absPath))) return { vocabulary: null, errors };
  try {
    const content = await fs.readFile(absPath);
    const result = parseVocabulary(content);
    errors.push(...result.errors);
    return { vocabulary: result.vocabulary ?? null, errors };
  } catch (err) {
    errors.push({
      code: 'INVALID_SEGMENT',
      message: `Error al leer ${VAULT_VOCAB_PATH}: ${String(err)}`,
    });
    return { vocabulary: null, errors };
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function scanNotePaths(
  fs: FilesystemPort,
  absDir: string,
  relPrefix: string,
): Promise<string[]> {
  const result: string[] = [];
  let entries: Awaited<ReturnType<FilesystemPort['readDir']>>;
  try {
    entries = await fs.readDir(absDir);
  } catch {
    return result;
  }
  for (const entry of entries) {
    const name = entry.name;
    const relPath = relPrefix === '' ? name : `${relPrefix}/${name}`;
    if (entry.isDirectory) {
      const topPart = relPath.split('/')[0] ?? '';
      if (VAULT_SKIP_DIRS.has(topPart.toLowerCase())) continue;
      if (name.startsWith('.')) continue;
      // B8: `tareas/<id>/evidencia/` is a path PREFIX, not a top-level dir —
      // VAULT_SKIP_DIRS only compares `relPath.split('/')[0]` and can never
      // match it. Skip the whole subtree so evidence files never become notes.
      if (isTaskEvidencePath(relPath)) continue;
      const subResults = await scanNotePaths(fs, `${absDir}/${name}`, relPath);
      result.push(...subResults);
    } else if (entry.isFile) {
      if (!name.endsWith('.md')) continue;
      if (name === 'INDEX.md') continue;
      if (isInvalidPath(relPath, 'win32')) continue;
      result.push(relPath);
    }
  }
  return result;
}

function joinVaultPath(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/');
}
