/**
 * obsidian/knowledge/topics.ts — high-level topic utilities for the knowledge
 * network (CHAMBA-016 wave 3).
 *
 * Functions provided:
 *   - closestTopics      — deterministic scoring of vocab nodes vs. a query
 *   - compactTopicTree   — ≤60-line Markdown tree from vocabulary
 *   - bootstrapStats     — deterministic vault statistics for /vault iniciar
 *   - renderVocabulary   — build VOCABULARIO.md from a proposed node list
 *   - writeVocabulary    — write VOCABULARIO.md with replace/dryRun guards
 *   - promotePlan        — diff for moving temas_propuestos → tags (read-only)
 *   - applyPromote       — execute the promote (writes files)
 *   - vocabularyAdd      — minimal insert of a new node into VOCABULARIO.md body
 *   - vocabularyAlias    — minimal add-alias to an existing node line
 *
 * Pure TypeScript — no `node:` imports, no external dependencies.
 * All I/O goes through FilesystemPort.
 */

import type { DirEntry, FilesystemPort } from '../../ports/filesystem.js';
import type { NoteMetadata } from './note-metadata.js';
import { readNoteMetadata, upsertNoteMetadata } from './note-metadata.js';
import type { TopicNode, Vocabulary, VocabularyError } from './vocabulary.js';
import { parseVocabulary } from './vocabulary.js';

// ─── STOPWORDS (es+en, matching context-builder plus broader set) ──────────────

/**
 * Stopwords for es+en used in term extraction from titles/summaries/headings.
 * Numbers and long hex hashes are filtered separately.
 */
export const STOPWORDS_ES_EN = new Set([
  // EN
  'the',
  'and',
  'for',
  'with',
  'add',
  'use',
  'that',
  'this',
  'into',
  'from',
  'all',
  'can',
  'should',
  'are',
  'was',
  'were',
  'has',
  'have',
  'had',
  'will',
  'not',
  'but',
  'its',
  'our',
  'your',
  'their',
  'been',
  'being',
  'each',
  'also',
  'more',
  'when',
  'then',
  'than',
  'how',
  'what',
  'where',
  'which',
  'who',
  'may',
  'must',
  'after',
  'before',
  'during',
  'over',
  'under',
  // ES
  'una',
  'uno',
  'unos',
  'unas',
  'para',
  'con',
  'los',
  'las',
  'del',
  'que',
  'por',
  'sin',
  'como',
  'sus',
  'son',
  'ser',
  'fue',
  'han',
  'hay',
  'este',
  'esta',
  'estos',
  'estas',
  'ese',
  'esa',
  'esos',
  'esas',
  'aquel',
  'aquella',
  'pero',
  'porque',
  'cuando',
  'donde',
  'cual',
  'quien',
  'sobre',
  'entre',
  'desde',
  'hasta',
  'hacia',
  'dentro',
  'fuera',
  'antes',
  'despues',
  'durante',
  'también',
  'tambien',
  'solo',
  'sólo',
  'más',
  'mas',
  'menos',
  'muy',
  'todo',
  'todos',
  'toda',
  'todas',
  'otra',
  'otro',
  'otros',
  'otras',
  'cada',
  'mismo',
  'misma',
  'como',
  'así',
  'bien',
  'vez',
  'algo',
  'nada',
  'parte',
  'parte',
  'nuevo',
  'nueva',
  'gran',
  'grande',
  'primero',
  'primera',
]);

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ClosestTopicResult {
  path: string;
  description: string;
  score: number;
}

export interface BootstrapFolder {
  path: string;
  count: number;
}

export interface BootstrapTag {
  tag: string;
  count: number;
}

export interface BootstrapTerm {
  term: string;
  count: number;
}

export interface BootstrapIndex {
  path: string;
  title: string;
}

export interface BootstrapWorkItem {
  id: string;
  files: string[];
}

export interface BootstrapStats {
  folders: BootstrapFolder[];
  tags: BootstrapTag[];
  topTerms: BootstrapTerm[];
  indexes: BootstrapIndex[];
  workItems: BootstrapWorkItem[];
}

export interface ProposedNode {
  path: string;
  description: string;
  aliases?: string[];
}

export interface RenderVocabularyOpts {
  umbral_promover?: number;
  umbral_dividir?: number;
  generar_bases?: boolean;
}

export interface RenderVocabularyResult {
  content: string | null;
  errors: VocabularyError[];
}

export interface WriteVocabularyOpts {
  /** If true, overwrite an existing VOCABULARIO.md. Default: false (error if exists). */
  replace?: boolean;
  /** If true, return content without writing. */
  dryRun?: boolean;
}

export interface PromoteDiff {
  path: string;
  before: Partial<NoteMetadata>;
  after: Partial<NoteMetadata>;
}

export interface PromotePlanResult {
  topicPath: string;
  diffs: PromoteDiff[];
}

// ─── Normalisation helpers ────────────────────────────────────────────────────

function stripCR(s: string): string {
  return s.endsWith('\r') ? s.slice(0, -1) : s;
}

/** NFC + lowercase + strip combining marks (accents). */
function normalizeToken(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Mark}/gu, '')
    .normalize('NFC');
}

/**
 * Tokenize a string into lowercase accent-stripped words.
 * Filters out tokens of length < 2, pure numbers, and long hex hashes (≥7 chars).
 */
function tokenize(s: string): string[] {
  return s
    .split(/[\s\-_/.,;:!?()[\]{}<>"'`|\\@#$%^&*=+~]+/)
    .map((t) => normalizeToken(t.trim()))
    .filter((t) => {
      if (t.length < 2) return false;
      if (/^\d+$/.test(t)) return false; // pure numbers
      if (t.length >= 7 && /^[0-9a-f]+$/i.test(t)) return false; // hex hash
      return true;
    });
}

// ─── closestTopics ────────────────────────────────────────────────────────────

/**
 * Score vocabulary nodes against a query (title + summary + keywords) and
 * return the top `n` closest nodes (deterministic, tiebreak by path asc).
 *
 * Scoring (per matched token, no partial matches):
 *   +3  exact match with the last slug segment
 *   +2  match with any other path segment
 *   +2  match with any alias
 *   +1  match with any description token
 */
export function closestTopics(
  vocab: Vocabulary,
  query: { title: string; summary?: string; keywords?: string[] },
  n = 5,
): ClosestTopicResult[] {
  const queryText = [query.title, query.summary ?? '', ...(query.keywords ?? [])].join(' ');
  const queryTokens = new Set(tokenize(queryText));

  if (queryTokens.size === 0) {
    // No query tokens — return first n nodes in path order
    return [...vocab.nodes.values()]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .slice(0, n)
      .map((node) => ({ path: node.path, description: node.description, score: 0 }));
  }

  const scored: ClosestTopicResult[] = [];

  for (const node of vocab.nodes.values()) {
    let score = 0;

    const segments = node.path.split('/');
    const lastSeg = segments[segments.length - 1] ?? '';
    const normalizedLastSeg = normalizeToken(lastSeg);

    // Score against last segment (slug)
    for (const qt of queryTokens) {
      if (qt === normalizedLastSeg) score += 3;
    }

    // Score against ancestor path segments
    for (let i = 0; i < segments.length - 1; i++) {
      const normSeg = normalizeToken(segments[i] ?? '');
      for (const qt of queryTokens) {
        if (qt === normSeg) score += 2;
      }
    }

    // Score against aliases
    for (const alias of node.aliases) {
      const normAlias = normalizeToken(alias);
      for (const qt of queryTokens) {
        if (qt === normAlias) score += 2;
      }
    }

    // Score against description tokens
    const descTokens = new Set(tokenize(node.description));
    for (const qt of queryTokens) {
      if (descTokens.has(qt)) score += 1;
    }

    scored.push({ path: node.path, description: node.description, score });
  }

  // Sort: higher score first; tiebreak: path asc
  scored.sort((a, b) =>
    b.score !== a.score ? b.score - a.score : a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );

  return scored.slice(0, n);
}

// ─── compactTopicTree ─────────────────────────────────────────────────────────

/**
 * Render the vocabulary as a compact Markdown tree (at most 60 lines).
 * If the full tree exceeds 60 lines, deepest levels are trimmed with "  …".
 *
 * Optional `counts` map provides note counts per topic path.
 */
export function compactTopicTree(vocab: Vocabulary, counts?: Map<string, number>): string {
  if (vocab.nodes.size === 0) {
    return '_El vocabulario está vacío._\n';
  }

  // Build sorted node list respecting tree structure
  const lines = renderTreeLines(vocab, counts, 4);

  if (lines.length <= 60) {
    return `${lines.join('\n')}\n`;
  }

  // Trim deepest levels progressively until ≤ 60 lines
  for (let maxDepth = 3; maxDepth >= 1; maxDepth--) {
    const trimmed = renderTreeLines(vocab, counts, maxDepth);
    if (trimmed.length <= 60) {
      return `${trimmed.join('\n')}\n`;
    }
  }

  // Last resort: return first 60 lines with truncation marker
  return `${lines.slice(0, 59).join('\n')}\n…\n`;
}

function renderTreeLines(
  vocab: Vocabulary,
  counts: Map<string, number> | undefined,
  maxDepth: number,
): string[] {
  const lines: string[] = [];

  // Get root nodes (no parent), sorted by path
  const roots = [...vocab.nodes.values()]
    .filter((n) => n.parent === null)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  function renderNode(node: TopicNode, depth: number): void {
    const indent = '  '.repeat(depth);
    const count = counts?.get(node.path);
    const countStr = count !== undefined ? ` (${count})` : '';
    const aliasStr = node.aliases.length > 0 ? `. Alias: ${node.aliases.join(', ')}` : '';
    lines.push(`${indent}- \`${node.path}\` — ${node.description}${aliasStr}${countStr}`);

    if (depth + 1 < maxDepth) {
      const childNodes = [...vocab.nodes.values()]
        .filter((n) => n.parent === node.path)
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      for (const child of childNodes) {
        renderNode(child, depth + 1);
      }
    } else {
      // Check if there are children we're hiding
      const hasChildren = [...vocab.nodes.values()].some((n) => n.parent === node.path);
      if (hasChildren) {
        lines.push(`${'  '.repeat(depth + 1)}…`);
      }
    }
  }

  for (const root of roots) {
    renderNode(root, 0);
  }

  return lines;
}

// ─── bootstrapStats ──────────────────────────────────────────────────────────

/** Pattern to detect work_item IDs in filenames. Documented:
 * - `hu-<slug>`: Historia de usuario (e.g. hu-lms-api-01, hu-soporte-01-login)
 * - `cu-<slug>`: ClickUp task slug  (e.g. cu-abc123)
 * - `#<alphanumeric>`: ClickUp-style short ID (e.g. #abc123)
 * - 7–9-char pure alphanumeric segment (e.g. abc1234, 9x8y7z6) — ClickUp-style IDs
 * Note: pure-numeric segments are excluded (those are dates, version numbers, etc.)
 */
const WORK_ITEM_PATTERNS = [
  /\b(hu-[a-z0-9]+(?:-[a-z0-9]+)*)/gi, // hu-lms-api-01
  /\b(cu-[a-z0-9]+(?:-[a-z0-9]+)*)/gi, // cu-abc123
  /#([a-z0-9]{2,12})/gi, // #abc123
];

/** Detect 7–9-char alphanumeric IDs that are not pure numbers. */
const ALPHANUM_ID_RE = /\b([a-z0-9]{7,9})\b/gi;

function detectWorkItemsFromFilename(filename: string): string[] {
  const base = filename.replace(/\.md$/i, '');
  const found = new Set<string>();

  for (const pattern of WORK_ITEM_PATTERNS) {
    pattern.lastIndex = 0;
    let m = pattern.exec(base);
    while (m !== null) {
      const id = m[1] ?? m[0];
      if (id) found.add(id.toLowerCase());
      m = pattern.exec(base);
    }
  }

  // 7–9 char alphanumeric (not pure numbers)
  ALPHANUM_ID_RE.lastIndex = 0;
  let m = ALPHANUM_ID_RE.exec(base);
  while (m !== null) {
    const id = m[1] ?? '';
    if (id && !/^\d+$/.test(id) && !/^[0-9a-f]{7,}$/.test(id)) {
      // Check it's not already captured (hu-/cu- prefix strips)
      if (!id.startsWith('hu') && !id.startsWith('cu')) {
        found.add(id.toLowerCase());
      }
    }
    m = ALPHANUM_ID_RE.exec(base);
  }

  return [...found];
}

const SKIP_DIRS_BOOTSTRAP = new Set([
  'memory',
  '.trash',
  '.obsidian',
  'temas',
  'node_modules',
  '.git',
  '.chamba-sync',
]);

/**
 * Compute deterministic vault statistics for the /vault iniciar bootstrap flow.
 * Two calls on the same vault yield identical results (order stable).
 */
export async function bootstrapStats(
  fs: FilesystemPort,
  vaultDir: string,
): Promise<BootstrapStats> {
  const folderCounts = new Map<string, number>(); // folder relPath → note count
  const tagCounts = new Map<string, number>(); // tag → count
  const termCounts = new Map<string, number>(); // term → count
  const indexes: BootstrapIndex[] = [];
  const workItemMap = new Map<string, string[]>(); // id → [relPath, ...]

  await scanBootstrap(fs, vaultDir, '', folderCounts, tagCounts, termCounts, indexes, workItemMap);

  // Sort folders by count desc, then path asc
  const folders: BootstrapFolder[] = [...folderCounts.entries()]
    .filter(([, c]) => c > 0)
    .sort(([pa, ca], [pb, cb]) => cb - ca || (pa < pb ? -1 : pa > pb ? 1 : 0))
    .map(([path, count]) => ({ path, count }));

  // Sort tags by count desc, then tag asc
  const tags: BootstrapTag[] = [...tagCounts.entries()]
    .sort(([ta, ca], [tb, cb]) => cb - ca || (ta < tb ? -1 : ta > tb ? 1 : 0))
    .map(([tag, count]) => ({ tag, count }));

  // Sort terms by count desc, then term asc; take top 30
  const topTerms: BootstrapTerm[] = [...termCounts.entries()]
    .sort(([ta, ca], [tb, cb]) => cb - ca || (ta < tb ? -1 : ta > tb ? 1 : 0))
    .slice(0, 30)
    .map(([term, count]) => ({ term, count }));

  // Sort indexes by path asc
  indexes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  // Sort work items by id asc
  const workItems: BootstrapWorkItem[] = [...workItemMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, files]) => ({ id, files: [...files].sort() }));

  return { folders, tags, topTerms, indexes, workItems };
}

async function scanBootstrap(
  fs: FilesystemPort,
  absDir: string,
  relPrefix: string,
  folderCounts: Map<string, number>,
  tagCounts: Map<string, number>,
  termCounts: Map<string, number>,
  indexes: BootstrapIndex[],
  workItemMap: Map<string, string[]>,
): Promise<void> {
  let entries: DirEntry[];
  try {
    entries = await fs.readDir(absDir);
  } catch {
    return;
  }

  let noteCountInFolder = 0;

  for (const entry of entries) {
    const name = entry.name;
    const relPath = relPrefix === '' ? name : `${relPrefix}/${name}`;

    if (entry.isDirectory) {
      const topPart = relPath.split('/')[0] ?? '';
      if (SKIP_DIRS_BOOTSTRAP.has(topPart.toLowerCase())) continue;
      if (name.startsWith('.')) continue;
      await scanBootstrap(
        fs,
        `${absDir}/${name}`,
        relPath,
        folderCounts,
        tagCounts,
        termCounts,
        indexes,
        workItemMap,
      );
    } else if (entry.isFile && name.endsWith('.md')) {
      // Handle INDEX.md / README.md separately
      if (name === 'INDEX.md' || name.toLowerCase() === 'readme.md') {
        try {
          const content = await fs.readFile(`${absDir}/${name}`);
          const meta = readNoteMetadata(content, relPath);
          indexes.push({ path: relPath, title: meta.title });
        } catch {
          // ignore
        }
        continue;
      }

      noteCountInFolder++;

      // Read note metadata
      try {
        const content = await fs.readFile(`${absDir}/${name}`);
        const meta = readNoteMetadata(content, relPath);

        // Count tags
        for (const tag of meta.tags) {
          tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
        }

        // Extract terms from title + summary + # headings
        const titleTokens = tokenize(meta.title);
        const summaryTokens = meta.summary ? tokenize(meta.summary) : [];
        const headingTokens = extractHeadingTerms(content);

        for (const t of [...titleTokens, ...summaryTokens, ...headingTokens]) {
          if (t.length >= 2 && !STOPWORDS_ES_EN.has(t)) {
            termCounts.set(t, (termCounts.get(t) ?? 0) + 1);
          }
        }

        // work_item from frontmatter
        if (meta.work_item) {
          const id = meta.work_item.toLowerCase();
          const arr = workItemMap.get(id) ?? [];
          arr.push(relPath);
          workItemMap.set(id, arr);
        }
      } catch {
        // ignore
      }

      // Detect work_item IDs from filename
      for (const id of detectWorkItemsFromFilename(name)) {
        const arr = workItemMap.get(id) ?? [];
        if (!arr.includes(relPath)) arr.push(relPath);
        workItemMap.set(id, arr);
      }
    }
  }

  if (relPrefix !== '' && noteCountInFolder > 0) {
    folderCounts.set(relPrefix, (folderCounts.get(relPrefix) ?? 0) + noteCountInFolder);
    // Propagate up (add to parent folder counts)
    let parent = dirnameOfPath(relPrefix);
    while (parent !== '') {
      folderCounts.set(parent, (folderCounts.get(parent) ?? 0) + noteCountInFolder);
      parent = dirnameOfPath(parent);
    }
  } else if (relPrefix === '' && noteCountInFolder > 0) {
    // Root-level notes
    folderCounts.set('(raíz)', (folderCounts.get('(raíz)') ?? 0) + noteCountInFolder);
  }
}

function extractHeadingTerms(content: string): string[] {
  const terms: string[] = [];
  for (const rawLine of content.split('\n')) {
    const line = stripCR(rawLine).trim();
    if (line.startsWith('#')) {
      // Remove the leading # characters
      const text = line.replace(/^#+\s*/, '');
      terms.push(...tokenize(text));
    }
  }
  return terms;
}

function dirnameOfPath(p: string): string {
  const idx = p.lastIndexOf('/');
  return idx === -1 ? '' : p.slice(0, idx);
}

// ─── renderVocabulary ─────────────────────────────────────────────────────────

/**
 * Build a VOCABULARIO.md string from a proposed flat node list.
 * The list must be in tree order (parents before children).
 * Validates with parseVocabulary. If there are errors, returns them
 * and `content: null` (does not generate broken content).
 */
export function renderVocabulary(
  nodes: ProposedNode[],
  opts: RenderVocabularyOpts = {},
): RenderVocabularyResult {
  const umbral_promover = opts.umbral_promover ?? 3;
  const umbral_dividir = opts.umbral_dividir ?? 25;
  const generar_bases = opts.generar_bases ?? true;

  const lines: string[] = [
    '---',
    'title: "Vocabulario de temas"',
    'source: human',
    `umbral_promover: ${umbral_promover}`,
    `umbral_dividir: ${umbral_dividir}`,
    `generar_bases: ${generar_bases}`,
    '---',
    '# Vocabulario de temas',
    '',
  ];

  for (const node of nodes) {
    const depth = node.path.split('/').length - 1; // 0 = root
    const indent = '  '.repeat(depth);
    const aliasStr =
      node.aliases && node.aliases.length > 0 ? `. Alias: ${node.aliases.join(', ')}` : '';
    lines.push(`${indent}- \`${node.path}\` — ${node.description}${aliasStr}`);
  }
  lines.push('');

  const content = lines.join('\n');

  // Validate
  const { errors } = parseVocabulary(content);
  if (errors.length > 0) {
    return { content: null, errors };
  }

  return { content, errors: [] };
}

// ─── writeVocabulary ──────────────────────────────────────────────────────────

const VOCAB_REL_PATH = 'temas/VOCABULARIO.md';

/**
 * Write VOCABULARIO.md to the vault.
 * - dryRun: return content without writing.
 * - exists && !replace: return error.
 */
export async function writeVocabulary(
  fs: FilesystemPort,
  vaultDir: string,
  content: string,
  opts: WriteVocabularyOpts = {},
): Promise<{ written: boolean; content: string; error?: string }> {
  const absPath = joinPath(vaultDir, VOCAB_REL_PATH);

  if (!opts.dryRun) {
    const exists = await fs.exists(absPath);
    if (exists && !opts.replace) {
      return {
        written: false,
        content,
        error: `Ya existe ${VOCAB_REL_PATH}. Pasa replace: true para sobreescribir.`,
      };
    }
  }

  if (opts.dryRun) {
    return { written: false, content };
  }

  // Ensure temas/ directory exists
  await mkdirSafe(fs, joinPath(vaultDir, 'temas'));
  await fs.writeFile(absPath, content);
  return { written: true, content };
}

// ─── promotePlan ──────────────────────────────────────────────────────────────

/**
 * Compute the diff for promoting a proposed topic to a vocabulary tag.
 * Finds notes whose `temas_propuestos` contains topicPath (or a `tema/<topicPath>` unknown tag).
 * Returns diffs (before/after frontmatter patches) without writing anything.
 *
 * Does NOT require the topic to already be in the vocabulary — that's checked in applyPromote.
 */
export async function promotePlan(
  fs: FilesystemPort,
  vaultDir: string,
  topicPath: string,
): Promise<PromotePlanResult> {
  const notes = await scanAllNotes(fs, vaultDir);
  const diffs: PromoteDiff[] = [];

  for (const { relPath, content } of notes) {
    const meta = readNoteMetadata(content, relPath);

    // Check if this note proposes the topic
    const inPropuestos = meta.temas_propuestos.some(
      (t) => normalizeToken(t.replace(/^tema\//, '')) === normalizeToken(topicPath),
    );
    const inUnknownTags = meta.tags.some(
      (t) =>
        t.startsWith('tema/') &&
        normalizeToken(t.slice('tema/'.length)) === normalizeToken(topicPath),
    );

    if (!inPropuestos && !inUnknownTags) continue;

    // Build before/after patches
    const newTemaTag = `tema/${topicPath}`;
    const existingNonTemaTags = meta.tags.filter((t) => !t.startsWith('tema/'));
    const existingTemaTags = meta.tags.filter((t) => t.startsWith('tema/'));
    const newTemaTags = [...new Set([...existingTemaTags, newTemaTag])];

    const newTags = [...existingNonTemaTags, ...newTemaTags];
    const newTemasPropuestos = meta.temas_propuestos.filter(
      (t) => normalizeToken(t.replace(/^tema\//, '')) !== normalizeToken(topicPath),
    );

    diffs.push({
      path: relPath,
      before: {
        tags: meta.tags,
        temas_propuestos: meta.temas_propuestos,
      },
      after: {
        tags: newTags,
        temas_propuestos: newTemasPropuestos,
      },
    });
  }

  return { topicPath, diffs };
}

/**
 * Apply a promote plan: add the node to the vocabulary (if not present; parent must exist),
 * then apply frontmatter changes (temas_propuestos → tags tema/) to each note in the diffs.
 * Only edits notes with source: chamba (never human notes) — unless they only have temas_propuestos edits.
 *
 * Actually per contract: applyPromote does apply to any note that requested the topic,
 * because classify/promote are confirmed actions. But the body remains intact (upsertNoteMetadata).
 */
export async function applyPromote(
  fs: FilesystemPort,
  vaultDir: string,
  topicPath: string,
  diffs: PromoteDiff[],
  vocabularyContent: string,
  description: string,
  aliases?: string[],
): Promise<{
  written: string[];
  vocabularyUpdated: boolean;
  errors: string[];
  newVocabContent: string;
}> {
  const errors: string[] = [];
  const written: string[] = [];

  // 1. Add node to vocabulary if not present
  let vocabContent = vocabularyContent;
  const { vocabulary } = parseVocabulary(vocabContent);
  let vocabularyUpdated = false;

  if (!vocabulary.nodes.has(topicPath)) {
    // Validate parent
    const parentIdx = topicPath.lastIndexOf('/');
    const parentPath = parentIdx === -1 ? null : topicPath.slice(0, parentIdx);
    if (parentPath !== null && !vocabulary.nodes.has(parentPath)) {
      errors.push(
        `No se puede añadir "${topicPath}": el padre "${parentPath}" no está en el vocabulario.`,
      );
      return { written, vocabularyUpdated: false, errors, newVocabContent: vocabContent };
    }

    const addResult = vocabularyAdd(vocabContent, { path: topicPath, description, aliases });
    if (addResult.error) {
      errors.push(addResult.error);
      return { written, vocabularyUpdated: false, errors, newVocabContent: vocabContent };
    }
    vocabContent = addResult.content;

    // Write vocabulary
    const absVocabPath = joinPath(vaultDir, VOCAB_REL_PATH);
    await mkdirSafe(fs, joinPath(vaultDir, 'temas'));
    await fs.writeFile(absVocabPath, vocabContent);
    vocabularyUpdated = true;
  }

  // 2. Apply diffs to notes
  for (const diff of diffs) {
    const absPath = joinPath(vaultDir, diff.path);
    try {
      const content = await fs.readFile(absPath);
      const updated = upsertNoteMetadata(content, diff.after);
      await fs.writeFile(absPath, updated);
      written.push(diff.path);
    } catch (e) {
      errors.push(`Error al actualizar "${diff.path}": ${String(e)}`);
    }
  }

  return { written, vocabularyUpdated, errors, newVocabContent: vocabContent };
}

// ─── vocabularyAdd ────────────────────────────────────────────────────────────

/**
 * Insert a new node line into VOCABULARIO.md content at the correct tree position.
 * The parent must exist (or null for root). Preserves all other bytes.
 * Validates alias uniqueness.
 *
 * Returns `{content, error}`. On error, content is unchanged.
 */
export function vocabularyAdd(
  content: string,
  node: ProposedNode,
): { content: string; error?: string } {
  const { vocabulary } = parseVocabulary(content);

  // Check if already exists
  if (vocabulary.nodes.has(node.path)) {
    return { content, error: `El nodo "${node.path}" ya existe en el vocabulario.` };
  }

  // Validate parent
  const parentIdx = node.path.lastIndexOf('/');
  const parentPath = parentIdx === -1 ? null : node.path.slice(0, parentIdx);
  if (parentPath !== null && !vocabulary.nodes.has(parentPath)) {
    return {
      content,
      error: `No se puede añadir "${node.path}": el padre "${parentPath}" no está declarado.`,
    };
  }

  // Validate alias uniqueness (don't check existing errors — just try inserting)
  const lastSeg = node.path.split('/').pop() ?? node.path;
  const usedAliases = new Set<string>();
  for (const n of vocabulary.nodes.values()) {
    usedAliases.add(n.path.split('/').pop() ?? n.path);
    for (const a of n.aliases) usedAliases.add(a.toLowerCase());
  }
  if (usedAliases.has(lastSeg)) {
    return { content, error: `El slug "${lastSeg}" ya está en uso en el vocabulario.` };
  }
  for (const alias of node.aliases ?? []) {
    const normAlias = alias.toLowerCase();
    if (usedAliases.has(normAlias)) {
      return { content, error: `El alias "${alias}" ya está en uso en el vocabulario.` };
    }
  }

  // Build the new line
  const depth = node.path.split('/').length - 1;
  const indent = '  '.repeat(depth);
  const aliasStr =
    node.aliases && node.aliases.length > 0 ? `. Alias: ${node.aliases.join(', ')}` : '';
  const newLine = `${indent}- \`${node.path}\` — ${node.description}${aliasStr}`;

  // Find insertion point in body
  const lines = content.split('\n');
  const insertIdx = findInsertionIndex(lines, node.path, parentPath, vocabulary);

  if (insertIdx === -1) {
    // Append before the last empty line or at end
    const lastNonEmpty = lines.reduceRight((acc, line, i) => {
      if (acc !== -1) return acc;
      return line.trim() !== '' ? i : -1;
    }, -1);
    const insertAt = lastNonEmpty === -1 ? lines.length : lastNonEmpty + 1;
    lines.splice(insertAt, 0, newLine);
  } else {
    lines.splice(insertIdx, 0, newLine);
  }

  return { content: lines.join('\n') };
}

/**
 * Find the index (in the split lines array) where a new node should be inserted.
 * Strategy:
 *   - If parent is null (root node): insert after the last root node in alphabetical order.
 *   - If parent exists: insert after the parent line and its existing children,
 *     in alphabetical order among siblings.
 */
function findInsertionIndex(
  lines: string[],
  newPath: string,
  parentPath: string | null,
  vocabulary: Vocabulary,
): number {
  const newLastSeg = newPath.split('/').pop() ?? newPath;
  const siblings = [...vocabulary.nodes.values()].filter((n) => n.parent === parentPath);
  const siblingPaths = siblings.map((s) => s.path);

  if (siblingPaths.length === 0) {
    // No existing siblings — insert right after parent line
    if (parentPath === null) {
      // Root with no existing roots — find end of body (before last empty line)
      return findBodyEnd(lines);
    }
    const parentLineIdx = findNodeLine(lines, parentPath);
    return parentLineIdx === -1 ? findBodyEnd(lines) : parentLineIdx + 1;
  }

  // Find where in the siblings alphabetically the new node should go
  const insertBeforePath = siblingPaths
    .sort((a, b) => {
      const aLast = a.split('/').pop() ?? a;
      const bLast = b.split('/').pop() ?? b;
      return aLast < bLast ? -1 : aLast > bLast ? 1 : 0;
    })
    .find((sp) => {
      const spLast = sp.split('/').pop() ?? sp;
      return newLastSeg < spLast;
    });

  if (insertBeforePath === undefined) {
    // Insert after the last sibling's subtree
    const sortedSiblings = [...siblingPaths].sort((a, b) => {
      const aLast = a.split('/').pop() ?? a;
      const bLast = b.split('/').pop() ?? b;
      return aLast < bLast ? -1 : aLast > bLast ? 1 : 0;
    });
    const lastSibling = sortedSiblings[sortedSiblings.length - 1];
    if (lastSibling === undefined) return findBodyEnd(lines);
    return findSubtreeEnd(lines, lastSibling, vocabulary);
  }

  const beforeIdx = findNodeLine(lines, insertBeforePath);
  return beforeIdx === -1 ? findBodyEnd(lines) : beforeIdx;
}

/** Find the line index containing a node with the given path. */
function findNodeLine(lines: string[], path: string): number {
  const backtickPath = `\`${path}\``;
  for (let i = 0; i < lines.length; i++) {
    const line = stripCR(lines[i] ?? '');
    const trimmed = line.trimStart();
    if (trimmed.startsWith('- `') && trimmed.includes(backtickPath)) {
      return i;
    }
  }
  return -1;
}

/**
 * Find the end of a node's subtree (index just after the last line that
 * belongs to the subtree of `nodePath`).
 */
function findSubtreeEnd(lines: string[], nodePath: string, vocabulary: Vocabulary): number {
  const nodeLineIdx = findNodeLine(lines, nodePath);
  if (nodeLineIdx === -1) return findBodyEnd(lines);

  // Collect all descendant paths
  const descendants = new Set<string>();
  const collectDesc = (p: string) => {
    for (const n of vocabulary.nodes.values()) {
      if (n.parent === p) {
        descendants.add(n.path);
        collectDesc(n.path);
      }
    }
  };
  collectDesc(nodePath);

  let end = nodeLineIdx + 1;
  for (let i = nodeLineIdx + 1; i < lines.length; i++) {
    const line = stripCR(lines[i] ?? '');
    const trimmed = line.trimStart();
    // Check if this line is a descendant node
    let isDesc = false;
    for (const desc of descendants) {
      const backtickPath = `\`${desc}\``;
      if (trimmed.startsWith('- `') && trimmed.includes(backtickPath)) {
        isDesc = true;
        break;
      }
    }
    if (isDesc) {
      end = i + 1;
    } else if (trimmed !== '' && !trimmed.startsWith('-') && !trimmed.startsWith(' ')) {
      // Non-indented non-list line — stop
      break;
    }
  }
  return end;
}

/** Find the index of the end of the body (before trailing empty lines). */
function findBodyEnd(lines: string[]): number {
  let last = lines.length;
  while (last > 0 && stripCR(lines[last - 1] ?? '').trim() === '') {
    last--;
  }
  return last;
}

// ─── vocabularyAlias ──────────────────────────────────────────────────────────

/**
 * Add an alias to an existing node in VOCABULARIO.md.
 * Validates that the alias is unique across the vocabulary.
 * Preserves all other bytes.
 *
 * Returns `{content, error}`.
 */
export function vocabularyAlias(
  content: string,
  path: string,
  alias: string,
): { content: string; error?: string } {
  const { vocabulary } = parseVocabulary(content);

  if (!vocabulary.nodes.has(path)) {
    return { content, error: `El nodo "${path}" no existe en el vocabulario.` };
  }

  // Check uniqueness
  const normAlias = alias.toLowerCase().trim();
  for (const node of vocabulary.nodes.values()) {
    if (node.aliases.map((a) => a.toLowerCase()).includes(normAlias)) {
      return { content, error: `El alias "${alias}" ya está en uso en "${node.path}".` };
    }
    if ((node.path.split('/').pop() ?? '') === normAlias) {
      return { content, error: `El alias "${alias}" ya coincide con el slug de "${node.path}".` };
    }
  }

  const lines = content.split('\n');
  const nodeLineIdx = findNodeLine(lines, path);
  if (nodeLineIdx === -1) {
    return { content, error: `No se encontró la línea del nodo "${path}" en el vocabulario.` };
  }

  // Rebuild the line
  const originalLine = lines[nodeLineIdx] ?? '';
  const stripped = stripCR(originalLine);
  const lineEnd = originalLine.endsWith('\r') ? '\r' : '';

  // Remove existing `. Alias: ...` part and rebuild
  const backtickPath = `\`${path}\``;
  const backtickIdx = stripped.indexOf(backtickPath);
  if (backtickIdx === -1) {
    return { content, error: `Formato inesperado en la línea del nodo "${path}".` };
  }

  const afterPath = stripped.slice(backtickIdx + backtickPath.length).trimStart();
  const emDash = '—';

  let newAliasArr: string[] = [];
  let baseDescription = '';

  if (afterPath.startsWith(emDash)) {
    const descRaw = afterPath.slice(emDash.length).trimStart();
    // Remove existing Alias: section
    const aliasMatch = descRaw.match(/^(.*?)\.\s+[Aa]lias(?:es?)?:\s+(.+)$/);
    if (aliasMatch) {
      baseDescription = (aliasMatch[1] ?? '').trim();
      newAliasArr = (aliasMatch[2] ?? '')
        .split(',')
        .map((a) => a.trim())
        .filter((a) => a !== '');
    } else {
      baseDescription = descRaw.endsWith('.') ? descRaw.slice(0, -1).trim() : descRaw.trim();
    }
  }

  newAliasArr.push(alias);

  const indent = stripped.slice(0, stripped.indexOf('- `'));
  const newLine = `${indent}- ${backtickPath} — ${baseDescription}. Alias: ${newAliasArr.join(', ')}${lineEnd}`;

  lines[nodeLineIdx] = newLine;
  return { content: lines.join('\n') };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/');
}

async function mkdirSafe(fs: FilesystemPort, dir: string): Promise<void> {
  try {
    await fs.mkdir(dir);
  } catch {
    // Ignore — dir may already exist
  }
}

async function scanAllNotes(
  fs: FilesystemPort,
  vaultDir: string,
): Promise<Array<{ relPath: string; content: string }>> {
  const results: Array<{ relPath: string; content: string }> = [];
  await scanAllNotesRecursive(fs, vaultDir, '', results);
  return results;
}

async function scanAllNotesRecursive(
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
      if (SKIP_DIRS_BOOTSTRAP.has(topPart.toLowerCase())) continue;
      if (name.startsWith('.')) continue;
      await scanAllNotesRecursive(fs, `${absDir}/${name}`, relPath, results);
    } else if (entry.isFile && name.endsWith('.md')) {
      if (name === 'INDEX.md') continue;
      try {
        const content = await fs.readFile(`${absDir}/${name}`);
        results.push({ relPath, content });
      } catch {
        // ignore
      }
    }
  }
}
