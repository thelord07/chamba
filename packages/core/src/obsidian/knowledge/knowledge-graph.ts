/**
 * obsidian/knowledge/knowledge-graph.ts — pure function that builds the
 * full set of derived vault files from note metadata and a vocabulary.
 *
 * `buildKnowledgeGraph(notes, vocabulary, opts?) → Map<string, string>`
 *
 * Inputs:
 *   - notes: GraphNote[]  (path relative to vault root, using `/`; metadata)
 *   - vocabulary: Vocabulary | null  (null → everything is unclassified)
 *
 * Outputs:
 *   Map from vault-relative path → file content (LF, UTF-8 NFC).
 *   Every generated file carries frontmatter `source: chamba`, `generated: true`
 *   and the canonical notice as a blockquote.
 *
 * Design constraints:
 *   - Pure — no fs, no clock, no `node:` imports.
 *   - Deterministic — same inputs ⇒ same bytes on any OS/JS engine.
 *   - Stable order: topic path → type → work_item → date desc → note path asc;
 *     comparison by code-point string order (not localeCompare).
 *
 * Pure TypeScript — no `node:` imports, no external dependencies.
 */

import type { NoteMetadata } from './note-metadata.js';
import type { Vocabulary } from './vocabulary.js';
import { ancestors, children, editDistance } from './vocabulary.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface GraphNote {
  /** Vault-relative path, `/`-separated (Windows `\` is normalised by the caller). */
  path: string;
  metadata: NoteMetadata;
}

export interface GraphOptions {
  /** Set to false to skip generating `.base` files even when vocab says so. */
  generateBases?: boolean;
}

export interface TopicSuggestion {
  /** Proposed topic slug/path (as it appeared in temas_propuestos or unknown tag). */
  proposed: string;
  /** Vault-relative paths of notes that requested this topic. */
  notes: string[];
  /** true when notes.length >= vocabulary.umbral_promover. */
  readyToPromote: boolean;
  /** Frequent keywords from requesting notes (hint for splitting). Set when the
   *  number of requesting notes exceeds vocabulary.umbral_dividir. */
  splitHint?: string[];
  /** Existing canonical paths at edit distance ≤ 2 from the proposed slug/path. */
  maybeSameAs?: string[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const NOTICE =
  'Generado por chamba desde los metadatos de las notas. No editar: edita las notas o temas/VOCABULARIO.md.';

/** Folders excluded from folder INDEX generation. Lower-case for comparison. */
const EXCLUDED_FOLDERS = new Set([
  'memory',
  '.trash',
  '.obsidian',
  'temas',
  'node_modules',
  '.git',
  '.chamba-sync',
]);

// ─── NFC helper ──────────────────────────────────────────────────────────────

function nfc(s: string): string {
  return s.normalize('NFC');
}

// ─── Path helpers (pure, no node:path) ───────────────────────────────────────

function normalisePath(p: string): string {
  return p.replace(/\\/g, '/').normalize('NFC');
}

function dirnameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? '' : trimmed.slice(0, idx);
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function encodePathSegment(segment: string): string {
  // Encode spaces as %20, other chars as needed for Obsidian/markdown links
  return segment.replace(/ /g, '%20');
}

function encodePath(path: string): string {
  return path.split('/').map(encodePathSegment).join('/');
}

/**
 * Compute the relative path from `fromFile`'s directory to `toFile`.
 * Both are vault-relative `/`-separated paths.
 */
function relativeFrom(fromFile: string, toFile: string): string {
  const fromDir = dirnameOf(fromFile); // '' for root
  const fromParts = fromDir === '' ? [] : fromDir.split('/');
  const toParts = toFile.split('/');

  // Find how many leading segments are common
  let common = 0;
  while (
    common < fromParts.length &&
    common < toParts.length - 1 &&
    fromParts[common] === toParts[common]
  ) {
    common++;
  }

  const ups = fromParts.length - common;
  const downParts = toParts.slice(common);
  const parts = [...Array(ups).fill('..'), ...downParts];
  return parts.length === 0 ? '.' : parts.join('/');
}

// ─── Stable comparison helpers ────────────────────────────────────────────────

/**
 * Case-insensitive comparison using Unicode code points for stability.
 * Tie broken by case-sensitive code-point comparison.
 */
function stableCmp(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la < lb) return -1;
  if (la > lb) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

// ─── Note sorting ─────────────────────────────────────────────────────────────

type NoteSortKey = {
  note: GraphNote;
  type: string;
  work_item: string | undefined;
  date: string;
};

function sortNotes(notes: GraphNote[]): GraphNote[] {
  const keyed: NoteSortKey[] = notes.map((n) => ({
    note: n,
    type: n.metadata.type ?? 'nota',
    work_item: n.metadata.work_item,
    date: n.metadata.date ?? '',
  }));

  keyed.sort((a, b) => {
    // 1. type (case-insensitive code-point)
    const tc = stableCmp(a.type, b.type);
    if (tc !== 0) return tc;

    // 2. work_item: notes WITH work_item come before notes WITHOUT
    const aHasWi = a.work_item !== undefined;
    const bHasWi = b.work_item !== undefined;
    if (aHasWi && !bHasWi) return -1;
    if (!aHasWi && bHasWi) return 1;
    if (aHasWi && bHasWi) {
      const wc = stableCmp(a.work_item as string, b.work_item as string);
      if (wc !== 0) return wc;
    }

    // 3. date descending (later date first)
    if (a.date > b.date) return -1;
    if (a.date < b.date) return 1;

    // 4. path ascending
    return stableCmp(a.note.path, b.note.path);
  });

  return keyed.map((k) => k.note);
}

// ─── Note line rendering ──────────────────────────────────────────────────────

/**
 * Render a single entry line for a note in a hub or folder index.
 * Format: `- [title](relative-path.md) — summary · claves: k1, k2 · type · date`
 * Parts that are empty are omitted deterministically.
 */
function renderNoteLine(fromFile: string, note: GraphNote): string {
  const rel = relativeFrom(fromFile, note.path);
  const encoded = encodePath(rel);
  const title = nfc(note.metadata.title || basenameOf(note.path).replace(/\.md$/, ''));
  let line = `- [${title}](${encoded})`;

  const parts: string[] = [];
  if (note.metadata.summary) parts.push(nfc(note.metadata.summary));

  const kws = (note.metadata.keywords ?? []).filter((k) => k.trim() !== '');
  if (kws.length > 0) parts.push(`claves: ${kws.map(nfc).join(', ')}`);

  if (note.metadata.type && note.metadata.type !== 'nota') parts.push(note.metadata.type);

  if (note.metadata.date) parts.push(note.metadata.date);

  if (parts.length > 0) {
    line += ` — ${parts.join(' · ')}`;
  }

  return line;
}

// ─── Generated file header ────────────────────────────────────────────────────

function generatedHeader(title: string): string {
  return [
    '---',
    `title: ${JSON.stringify(nfc(title))}`,
    'source: chamba',
    'generated: true',
    '---',
    '',
    `> ${nfc(NOTICE)}`,
    '',
  ].join('\n');
}

// ─── computeSuggestions ───────────────────────────────────────────────────────

/**
 * Compute suggested actions for the `temas/PROPUESTOS.md` file and for the
 * status/doctor commands.
 *
 * Collects:
 *   - Proposed topics from `temas_propuestos` of notes.
 *   - Unknown tags (tags starting with `tema/` not in the vocabulary) from all notes.
 * For each proposed topic:
 *   - List of requesting notes.
 *   - readyToPromote when count ≥ umbral_promover.
 *   - splitHint when count > umbral_dividir (top-5 most frequent keywords).
 *   - maybeSameAs when edit distance ≤ 2 from an existing slug/alias/path.
 */
export function computeSuggestions(
  notes: GraphNote[],
  vocabulary: Vocabulary | null,
): TopicSuggestion[] {
  const umbral_promover = vocabulary?.umbral_promover ?? 3;
  const umbral_dividir = vocabulary?.umbral_dividir ?? 25;

  // Map: proposed-slug → array of note paths
  const proposed = new Map<string, string[]>();

  const addProposed = (slug: string, notePath: string) => {
    const key = nfc(
      slug
        .trim()
        .toLowerCase()
        .replace(/^tema\//, ''),
    );
    if (key === '') return;
    const arr = proposed.get(key) ?? [];
    if (!arr.includes(notePath)) arr.push(notePath);
    proposed.set(key, arr);
  };

  for (const n of notes) {
    // Explicitly proposed
    for (const p of n.metadata.temas_propuestos ?? []) {
      addProposed(p, n.path);
    }
    // Unknown tags (in vocabulary mode only)
    if (vocabulary !== null) {
      for (const tag of n.metadata.tags ?? []) {
        if (!tag.startsWith('tema/')) continue;
        const slug = tag.slice('tema/'.length);
        if (!vocabulary.nodes.has(slug)) {
          addProposed(slug, n.path);
        }
      }
    }
  }

  // Build alias set for edit-distance checks
  const allAliases: string[] = [];
  if (vocabulary) {
    for (const node of vocabulary.nodes.values()) {
      allAliases.push(node.path);
      const lastSeg = node.path.split('/').pop() ?? '';
      if (lastSeg && !allAliases.includes(lastSeg)) allAliases.push(lastSeg);
      for (const a of node.aliases) allAliases.push(a);
    }
  }

  // Keyword frequency per proposed topic
  const noteKeywords = new Map<string, string[]>();
  for (const n of notes) {
    noteKeywords.set(n.path, n.metadata.keywords ?? []);
  }

  const result: TopicSuggestion[] = [];

  for (const [slug, notePaths] of [...proposed.entries()].sort(([a], [b]) => stableCmp(a, b))) {
    const readyToPromote = notePaths.length >= umbral_promover;

    let splitHint: string[] | undefined;
    if (notePaths.length > umbral_dividir) {
      // Count keyword frequency
      const freq = new Map<string, number>();
      for (const np of notePaths) {
        for (const kw of noteKeywords.get(np) ?? []) {
          const k = nfc(kw.toLowerCase().trim());
          if (k) freq.set(k, (freq.get(k) ?? 0) + 1);
        }
      }
      splitHint = [...freq.entries()]
        .sort(([ka, ca], [kb, cb]) => cb - ca || stableCmp(ka, kb))
        .slice(0, 5)
        .map(([kw]) => kw);
    }

    let maybeSameAs: string[] | undefined;
    const closeExisting = allAliases
      .map((a) => ({ a, d: editDistance(slug, a) }))
      .filter(({ d }) => d <= 2 && d > 0)
      .sort((x, y) => x.d - y.d || stableCmp(x.a, y.a))
      .map(({ a }) => {
        // Resolve to canonical path
        if (vocabulary?.nodes.has(a)) return a;
        for (const node of vocabulary?.nodes.values() ?? []) {
          if (node.aliases.includes(a)) return node.path;
          if (node.path.split('/').pop() === a) return node.path;
        }
        return a;
      });
    const seenCanonical = new Set<string>();
    const deduped: string[] = [];
    for (const c of closeExisting) {
      if (!seenCanonical.has(c)) {
        seenCanonical.add(c);
        deduped.push(c);
      }
    }
    if (deduped.length > 0) maybeSameAs = deduped;

    result.push({
      proposed: slug,
      notes: [...notePaths].sort(stableCmp),
      readyToPromote,
      ...(splitHint !== undefined ? { splitHint } : {}),
      ...(maybeSameAs !== undefined ? { maybeSameAs } : {}),
    });
  }

  return result;
}

// ─── Main: buildKnowledgeGraph ────────────────────────────────────────────────

/**
 * Build all derived vault files from the given notes and vocabulary.
 *
 * @param notes      - Array of GraphNote (path relative to vault root, `/`-sep).
 * @param vocabulary - Parsed vocabulary, or `null` (→ everything unclassified).
 * @param opts       - Optional overrides.
 * @returns Map from vault-relative path → file content (LF, UTF-8 NFC).
 */
export function buildKnowledgeGraph(
  notes: GraphNote[],
  vocabulary: Vocabulary | null,
  opts?: GraphOptions,
): Map<string, string> {
  const generateBases = opts?.generateBases ?? vocabulary?.generar_bases ?? true;

  // Normalise paths
  const normNotes: GraphNote[] = notes.map((n) => ({
    path: normalisePath(n.path),
    metadata: n.metadata,
  }));

  // ── Step 1: classify notes ─────────────────────────────────────────────────
  // For each note, determine which vocabulary nodes it maps to (valid temas)
  // and which tags are unknown (proposed).

  interface ClassifiedNote {
    note: GraphNote;
    validTemas: string[]; // paths in vocabulary
    unknownTemas: string[]; // tags starting with tema/ not in vocabulary
    isUnclassified: boolean; // no valid temas
  }

  const classified: ClassifiedNote[] = normNotes.map((note) => {
    if (vocabulary === null) {
      return { note, validTemas: [], unknownTemas: [], isUnclassified: true };
    }
    const validTemas: string[] = [];
    const unknownTemas: string[] = [];
    for (const tag of note.metadata.tags ?? []) {
      if (!tag.startsWith('tema/')) continue;
      const slug = tag.slice('tema/'.length);
      if (vocabulary.nodes.has(slug)) {
        if (!validTemas.includes(slug)) validTemas.push(slug);
      } else {
        if (!unknownTemas.includes(slug)) unknownTemas.push(slug);
      }
    }
    return { note, validTemas, unknownTemas, isUnclassified: validTemas.length === 0 };
  });

  // ── Step 2: subtree count per node ─────────────────────────────────────────
  // subtreeNotes(node) = set of notes where at least one validTema is node or
  // a descendant of node.

  const nodeNotes = new Map<string, Set<string>>(); // node path → set of note paths
  if (vocabulary !== null) {
    for (const node of vocabulary.nodes.values()) {
      nodeNotes.set(node.path, new Set());
    }
    for (const cn of classified) {
      if (cn.isUnclassified) continue;
      const visited = new Set<string>();
      for (const tema of cn.validTemas) {
        // Add the note to this node and all ancestors
        const chain = [tema, ...ancestors(tema)];
        for (const p of chain) {
          if (vocabulary.nodes.has(p) && !visited.has(p)) {
            visited.add(p);
            const s = nodeNotes.get(p);
            if (s) s.add(cn.note.path);
          }
        }
      }
    }
  }

  // ── Step 3: direct notes per node ─────────────────────────────────────────
  // directNotes(node) = notes where this exact node appears in validTemas.
  const directNotes = new Map<string, GraphNote[]>();
  if (vocabulary !== null) {
    for (const node of vocabulary.nodes.values()) {
      directNotes.set(node.path, []);
    }
    for (const cn of classified) {
      for (const tema of cn.validTemas) {
        directNotes.get(tema)?.push(cn.note);
      }
    }
  }

  const output = new Map<string, string>();

  // ── Step 4: suggestions (for PROPUESTOS.md) ────────────────────────────────
  const suggestions = computeSuggestions(normNotes, vocabulary);
  const hasProposals = suggestions.length > 0;

  // ── Step 5: hub files per node ─────────────────────────────────────────────
  if (vocabulary !== null) {
    for (const node of vocabulary.nodes.values()) {
      const subtreeNotesCount = nodeNotes.get(node.path)?.size ?? 0;
      if (subtreeNotesCount === 0) continue; // no hub for empty subtrees

      const hubPath = `temas/${node.path}.md`;
      const content = renderHubFile(node, vocabulary, directNotes, nodeNotes, hubPath);
      output.set(hubPath, content);
    }
  }

  // ── Step 6: temas/sin-clasificar.md ────────────────────────────────────────
  const unclassifiedNotes = classified.filter((cn) => cn.isUnclassified);
  {
    const content = renderUnclassifiedFile(unclassifiedNotes.map((cn) => cn.note));
    output.set('temas/sin-clasificar.md', content);
  }

  // ── Step 7: temas/PROPUESTOS.md ────────────────────────────────────────────
  if (hasProposals) {
    const content = renderProposedFile(suggestions, vocabulary);
    output.set('temas/PROPUESTOS.md', content);
  }

  // ── Step 8: folder INDEX.md files ─────────────────────────────────────────
  // Group notes by their folder (excluding root-level notes for now — they'll
  // appear in the root INDEX.md).
  const folderNotes = new Map<string, ClassifiedNote[]>();
  for (const cn of classified) {
    const folder = dirnameOf(cn.note.path);
    if (folder === '') continue; // root-level notes handled in root INDEX
    // Skip excluded top-level folders
    const topFolder = folder.split('/')[0] ?? '';
    if (EXCLUDED_FOLDERS.has(topFolder.toLowerCase())) continue;

    const existing = folderNotes.get(folder) ?? [];
    existing.push(cn);
    folderNotes.set(folder, existing);
  }

  // Collect all unique folders (including parent folders)
  const allFolders = new Set<string>();
  for (const folder of folderNotes.keys()) {
    // Add this folder and all its ancestors (to ensure parent folders get an INDEX too)
    let f = folder;
    while (f !== '') {
      const topF = f.split('/')[0] ?? '';
      if (EXCLUDED_FOLDERS.has(topF.toLowerCase())) break;
      allFolders.add(f);
      f = dirnameOf(f);
    }
  }

  // For each folder, generate INDEX.md (only direct notes in that folder)
  for (const folder of [...allFolders].sort(stableCmp)) {
    const directCns = folderNotes.get(folder) ?? [];
    if (directCns.length === 0) continue; // no notes directly in this folder

    const indexPath = `${folder}/INDEX.md`;
    const content = renderFolderIndex(folder, directCns, vocabulary, indexPath);
    output.set(indexPath, content);
  }

  // ── Step 9: root INDEX.md ─────────────────────────────────────────────────
  const rootContent = renderRootIndex(
    vocabulary,
    nodeNotes,
    allFolders,
    unclassifiedNotes.length,
    hasProposals,
  );
  output.set('INDEX.md', rootContent);

  // ── Step 10: .base files ──────────────────────────────────────────────────
  if (generateBases && vocabulary !== null) {
    for (const node of vocabulary.nodes.values()) {
      if (node.parent !== null) continue; // only root-level nodes
      const subtreeCount = nodeNotes.get(node.path)?.size ?? 0;
      if (subtreeCount === 0) continue;
      const basePath = `temas/${node.path}.base`;
      const content = renderBaseFile(node.path);
      output.set(basePath, content);
    }
  }

  return output;
}

// ─── Hub file renderer ────────────────────────────────────────────────────────

function renderHubFile(
  node: { path: string; description: string; aliases: string[]; parent: string | null },
  vocabulary: Vocabulary,
  directNotes: Map<string, GraphNote[]>,
  nodeNotes: Map<string, Set<string>>,
  hubPath: string,
): string {
  const lines: string[] = [];

  // Frontmatter
  const title = nfc(node.path.split('/').pop() ?? node.path);
  lines.push('---');
  lines.push(`title: ${JSON.stringify(title)}`);
  if (node.description) lines.push(`description: ${JSON.stringify(nfc(node.description))}`);
  if (node.aliases.length > 0) {
    lines.push(`aliases: [${node.aliases.map((a) => JSON.stringify(nfc(a))).join(', ')}]`);
  }
  lines.push('source: chamba');
  lines.push('generated: true');
  lines.push('---');
  lines.push('');
  lines.push(`> ${nfc(NOTICE)}`);
  lines.push('');
  lines.push(`# ${nfc(node.path)}`);
  lines.push('');
  if (node.description) {
    lines.push(`${nfc(node.description)}`);
    lines.push('');
  }

  // Link to parent or root INDEX
  if (node.parent !== null) {
    const parentHub = `temas/${node.parent}.md`;
    const rel = relativeFrom(hubPath, parentHub);
    lines.push(`Tema padre: [${nfc(node.parent)}](${encodePath(rel)})`);
  } else {
    const rel = relativeFrom(hubPath, 'INDEX.md');
    lines.push(`[← Índice raíz](${encodePath(rel)})`);
  }
  lines.push('');

  // Subtemas section
  const childPaths = children(vocabulary, node.path).filter(
    (c) => (nodeNotes.get(c)?.size ?? 0) > 0,
  );

  if (childPaths.length > 0) {
    lines.push('## Subtemas');
    lines.push('');
    for (const childPath of childPaths.sort(stableCmp)) {
      const childNode = vocabulary.nodes.get(childPath);
      if (!childNode) continue;
      const count = nodeNotes.get(childPath)?.size ?? 0;
      const childHub = `temas/${childPath}.md`;
      const rel = relativeFrom(hubPath, childHub);
      const lastSeg = childPath.split('/').pop() ?? childPath;
      lines.push(
        `- [${nfc(lastSeg)}](${encodePath(rel)}) — ${count} nota${count !== 1 ? 's' : ''}`,
      );
    }
    lines.push('');
  }

  // Notas section: notes tagged directly in this node
  const notesHere = sortNotes([...(directNotes.get(node.path) ?? [])]);
  if (notesHere.length > 0) {
    lines.push('## Notas');
    lines.push('');

    // Group by type
    const byType = new Map<string, GraphNote[]>();
    for (const n of notesHere) {
      const t = n.metadata.type ?? 'nota';
      const arr = byType.get(t) ?? [];
      arr.push(n);
      byType.set(t, arr);
    }

    // Sort type keys
    const typeKeys = [...byType.keys()].sort(stableCmp);

    for (const typeKey of typeKeys) {
      lines.push(`### ${nfc(typeKey)}`);
      lines.push('');

      const notesOfType = sortNotes(byType.get(typeKey) ?? []);

      // Group by work_item within this type
      const byWi = new Map<string | undefined, GraphNote[]>();
      for (const n of notesOfType) {
        const wi = n.metadata.work_item;
        const arr = byWi.get(wi) ?? [];
        arr.push(n);
        byWi.set(wi, arr);
      }

      // Notes with work_item first (sorted by work_item), then undefined
      const wiKeys = [...byWi.keys()].filter((k): k is string => k !== undefined).sort(stableCmp);
      const wiOrder: (string | undefined)[] = [...wiKeys, undefined];

      for (const wi of wiOrder) {
        const group = byWi.get(wi);
        if (!group || group.length === 0) continue;
        for (const n of sortNotes(group)) {
          lines.push(renderNoteLine(hubPath, n));
        }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─── Unclassified file renderer ───────────────────────────────────────────────

function renderUnclassifiedFile(notes: GraphNote[]): string {
  const fromFile = 'temas/sin-clasificar.md';
  const lines: string[] = [];
  lines.push(...generatedHeader('Sin clasificar').split('\n'));
  lines.push('# Sin clasificar');
  lines.push('');
  lines.push('Notas sin temas válidos en el vocabulario.');
  lines.push('');

  if (notes.length === 0) {
    lines.push('_(ninguna)_');
    lines.push('');
  } else {
    for (const n of sortNotes(notes)) {
      lines.push(renderNoteLine(fromFile, n));
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── PROPUESTOS.md renderer ───────────────────────────────────────────────────

function renderProposedFile(suggestions: TopicSuggestion[], vocabulary: Vocabulary | null): string {
  const fromFile = 'temas/PROPUESTOS.md';
  const lines: string[] = [];
  lines.push(...generatedHeader('Temas propuestos').split('\n'));
  lines.push('# Temas propuestos');
  lines.push('');
  lines.push('Temas solicitados por notas que aún no están en el vocabulario.');
  lines.push('');

  for (const sug of suggestions) {
    const count = sug.notes.length;
    lines.push(`## \`${nfc(sug.proposed)}\``);
    lines.push('');
    lines.push(`${count} nota${count !== 1 ? 's' : ''} solicitante${count !== 1 ? 's' : ''}:`);
    lines.push('');
    for (const notePath of sug.notes.sort(stableCmp)) {
      // Link relative from temas/PROPUESTOS.md to the note
      const rel = relativeFrom(fromFile, notePath);
      lines.push(`- [${nfc(notePath)}](${encodePath(rel)})`);
    }
    lines.push('');

    if (sug.readyToPromote) {
      lines.push(
        `> **✓ Listo para aprobar** — ${count} notas alcanzan el umbral (${vocabulary?.umbral_promover ?? 3}).`,
      );
      lines.push('');
    }

    if (sug.splitHint && sug.splitHint.length > 0) {
      lines.push(
        `> **Dividir en subtemas** — ${count} notas directas superan el umbral (${vocabulary?.umbral_dividir ?? 25}).`,
      );
      lines.push(`> Keywords frecuentes: ${sug.splitHint.map((k) => `\`${k}\``).join(', ')}`);
      lines.push('');
    }

    if (sug.maybeSameAs && sug.maybeSameAs.length > 0) {
      for (const existing of sug.maybeSameAs) {
        lines.push(`> **¿Es el mismo que \`${nfc(existing)}\`?** (distancia de edición ≤ 2)`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─── Folder INDEX renderer ────────────────────────────────────────────────────

interface ClassifiedNote {
  note: GraphNote;
  validTemas: string[];
  unknownTemas: string[];
  isUnclassified: boolean;
}

function renderFolderIndex(
  folder: string,
  cns: ClassifiedNote[],
  vocabulary: Vocabulary | null,
  _indexPath: string,
): string {
  const folderName = nfc(basenameOf(folder) || folder);
  const lines: string[] = [];
  lines.push('---');
  lines.push(`title: ${JSON.stringify(`${folderName} — índice`)}`);
  lines.push('source: chamba');
  lines.push('generated: true');
  lines.push('---');
  lines.push('');
  lines.push(`> ${nfc(NOTICE)}`);
  lines.push('');
  lines.push(`# ${folderName}`);
  lines.push('');

  // Group notes by their first valid tema (or "Sin clasificar")
  const grouped = new Map<string | null, ClassifiedNote[]>(); // null = unclassified
  for (const cn of cns) {
    const firstTema = cn.validTemas.length > 0 ? (cn.validTemas[0] ?? null) : null;
    const arr = grouped.get(firstTema) ?? [];
    arr.push(cn);
    grouped.set(firstTema, arr);
  }

  // Sort topic keys (non-null first, alphabetically, then null)
  const topicKeys = [...grouped.keys()].filter((k): k is string => k !== null).sort(stableCmp);
  const orderedKeys: (string | null)[] = [...topicKeys, null];

  for (const key of orderedKeys) {
    const group = grouped.get(key);
    if (!group || group.length === 0) continue;

    const heading = key !== null ? nfc(key) : 'Sin clasificar';
    lines.push(`## ${heading}`);
    lines.push('');

    // Get node description for the topic heading
    if (key !== null && vocabulary) {
      const node = vocabulary.nodes.get(key);
      if (node?.description) {
        lines.push(`_${nfc(node.description)}_`);
        lines.push('');
      }
    }

    for (const cn of sortNotes(group.map((c) => c.note)).map(
      (n) => group.find((c) => c.note.path === n.path) as ClassifiedNote,
    )) {
      const noteFile = basenameOf(cn.note.path);
      const title = nfc(cn.note.metadata.title || noteFile.replace(/\.md$/, ''));
      const summary = cn.note.metadata.summary ? ` — ${nfc(cn.note.metadata.summary)}` : '';
      lines.push(`- [${title}](${encodePathSegment(noteFile)})${summary}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Root INDEX renderer ──────────────────────────────────────────────────────

function renderRootIndex(
  vocabulary: Vocabulary | null,
  nodeNotes: Map<string, Set<string>>,
  folderNames: Set<string>,
  unclassifiedCount: number,
  hasProposals: boolean,
): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('title: "Índice del vault"');
  lines.push('source: chamba');
  lines.push('generated: true');
  lines.push('---');
  lines.push('');
  lines.push(`> ${nfc(NOTICE)}`);
  lines.push('');
  lines.push('# Índice');
  lines.push('');

  // Root-level topics (nodes without parent)
  if (vocabulary !== null) {
    const rootNodes = [...vocabulary.nodes.values()]
      .filter((n) => n.parent === null)
      .sort((a, b) => stableCmp(a.path, b.path));

    if (rootNodes.length > 0) {
      lines.push('## Temas');
      lines.push('');
      for (const node of rootNodes) {
        const count = nodeNotes.get(node.path)?.size ?? 0;
        if (count === 0) continue;
        const hubPath = `temas/${node.path}.md`;
        const rel = relativeFrom('INDEX.md', hubPath);
        const desc = node.description ? ` — ${nfc(node.description)}` : '';
        lines.push(
          `- [${nfc(node.path)}](${encodePath(rel)})${desc} · ${count} nota${count !== 1 ? 's' : ''}`,
        );
      }
      lines.push('');
    }
  }

  // Folders
  const topFolders = [...folderNames]
    .filter((f) => !f.includes('/')) // only top-level folders
    .sort(stableCmp);

  if (topFolders.length > 0) {
    lines.push('## Carpetas');
    lines.push('');
    for (const folder of topFolders) {
      const indexPath = `${folder}/INDEX.md`;
      const rel = relativeFrom('INDEX.md', indexPath);
      lines.push(`- [${nfc(folder)}](${encodePath(rel)})`);
    }
    lines.push('');
  }

  // Sin clasificar
  {
    const rel = relativeFrom('INDEX.md', 'temas/sin-clasificar.md');
    lines.push(
      `[Sin clasificar](${encodePath(rel)}): ${unclassifiedCount} nota${unclassifiedCount !== 1 ? 's' : ''}`,
    );
    lines.push('');
  }

  // Proposed
  if (hasProposals) {
    const rel = relativeFrom('INDEX.md', 'temas/PROPUESTOS.md');
    lines.push(`[Temas propuestos](${encodePath(rel)})`);
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Base file renderer ────────────────────────────────────────────────────────

function renderBaseFile(rootPath: string): string {
  const tagFilter = `tema/${nfc(rootPath)}`;
  return [
    `# generated: true — source: chamba — ${nfc(NOTICE)}`,
    `filters:`,
    `  and:`,
    `    - file.hasTag("${tagFilter}")`,
    `views:`,
    `  - type: table`,
    `    name: ${nfc(rootPath)}`,
    `    order: [file.name, note.type, note.summary, note.work_item, note.date]`,
    `    groupBy:`,
    `      property: note.type`,
    `      direction: ASC`,
    '',
  ].join('\n');
}
