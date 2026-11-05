/**
 * obsidian/knowledge/context-map.ts — deterministic relevance map for load_context.
 *
 * `buildContextMap(notes, vocab, task, opts)` → `{ section: string, mapa: MapaStruct }`
 *
 * Scoring algorithm:
 *   Step 1 — Score vocab nodes: score(node) = Σ occurrences(haystack(node), kw).
 *             Top 3 with parent/child rule (child wins on tie or if child.score ≥ parent.score).
 *   Step 2 — Score notes per node (subtree): score(note) = base + 2 × kwScore.
 *             ≤5 notes per node. Global dedupe.
 *   Step 3 — Work item notes: notes matching a work_item mentioned in the task
 *             (always included, in a separate "Work item" group).
 *   Step 4 — Render + budget enforcement (≤ mapBudgetChars = floor(maxTokens*4*0.25)).
 *
 * Pure TypeScript: no `node:` imports, no external dependencies, no IO.
 */

import { extractKeywords, occurrences } from '../../workspace/keywords.js';
import type { GraphNote } from './knowledge-graph.js';
import { stableCmp } from './knowledge-graph.js';
import type { Vocabulary } from './vocabulary.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface MapaNoteItem {
  titulo: string;
  ruta: string;
  type: string;
  summary?: string;
  keywords: string[];
  workItem?: string;
  date?: string;
  score: number;
}

export interface MapaNode {
  ruta: string;
  descripcion: string;
  conteoSubarbol: number;
  notas: MapaNoteItem[];
}

export interface MapaWorkItem {
  id: string;
  notas: MapaNoteItem[];
}

export interface MapaStruct {
  nodos: MapaNode[];
  workItems: MapaWorkItem[];
  recortado: boolean;
  reglasRecortadas?: boolean;
}

export interface BuildContextMapOptions {
  /** Soft cap for the whole context, in estimated tokens (~4 chars/token). Default 2000. */
  maxTokens?: number;
}

// ─── Implementation ───────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS = 2000;
const MAX_NOTES_PER_NODE = 5;
const MAX_TOP_NODES = 3;

/** Regex for work-item IDs: e.g. `hu-lms-api-01`, `fix-auth-123` */
const WORK_ITEM_RE = /\b[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/gi;

/**
 * Build the vault context map section from notes, vocabulary, and a task description.
 *
 * @param notes  - All notes in the vault (vault-relative paths, `/`-separated).
 * @param vocab  - Parsed vocabulary, or `null`.
 * @param task   - The task description (used for keyword scoring).
 * @param opts   - Options (maxTokens).
 */
export function buildContextMap(
  notes: GraphNote[],
  vocab: Vocabulary | null,
  task: string,
  opts: BuildContextMapOptions = {},
): { section: string; mapa: MapaStruct } {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const mapBudgetChars = Math.floor(maxTokens * 4 * 0.25);

  const keywords = extractKeywords(task);

  // ── Step 1: score vocab nodes ──────────────────────────────────────────────
  const scoredNodes = scoreNodes(notes, vocab, keywords);

  // ── Step 2: score notes per node ──────────────────────────────────────────
  const { nodos, dedupeSet } = buildNodeEntries(
    notes,
    vocab,
    scoredNodes,
    keywords,
    MAX_NOTES_PER_NODE,
  );

  // ── Step 3: work_item notes ────────────────────────────────────────────────
  const workItems = buildWorkItemEntries(notes, task, dedupeSet);

  // ── Step 4: budget enforcement ────────────────────────────────────────────
  const mapa = enforceMapBudget(
    { nodos, workItems, recortado: false },
    mapBudgetChars,
    notes,
    vocab,
    scoredNodes,
    keywords,
  );

  const section = renderMapaSection(mapa);
  return { section, mapa };
}

// ─── Scoring helpers ──────────────────────────────────────────────────────────

interface ScoredNode {
  path: string;
  score: number;
}

/**
 * Score all vocab nodes and return the top-3 selection with parent/child rule.
 */
function scoreNodes(
  _notes: GraphNote[],
  vocab: Vocabulary | null,
  keywords: string[],
): ScoredNode[] {
  if (!vocab || keywords.length === 0) return [];

  // Score each node
  const scored: ScoredNode[] = [];
  for (const [path, node] of vocab.nodes) {
    const haystack = `${path} ${node.aliases.join(' ')} ${node.description}`
      .normalize('NFC')
      .toLowerCase();
    const score = sumOccurrences(haystack, keywords);
    if (score > 0) scored.push({ path, score });
  }

  // Sort: score desc, then path asc
  scored.sort((a, b) => b.score - a.score || stableCmp(a.path, b.path));

  // Select up to MAX_TOP_NODES with parent/child rule
  const selected: ScoredNode[] = [];

  for (const candidate of scored) {
    if (selected.length >= MAX_TOP_NODES) break;

    let handled = false;
    for (let i = 0; i < selected.length; i++) {
      const existing = selected[i];
      if (!existing) continue;

      const candidateIsDescendant = isDescendant(candidate.path, existing.path);
      const candidateIsAncestor = isDescendant(existing.path, candidate.path);

      if (candidateIsDescendant) {
        // candidate is a child/descendant of existing
        // Rule: child wins on tie or if child.score > parent.score
        if (candidate.score >= existing.score) {
          selected[i] = candidate;
        }
        // else: existing has higher score, discard candidate
        handled = true;
        break;
      }

      if (candidateIsAncestor) {
        // candidate is a parent/ancestor of existing
        // Rule: parent only wins if it has strictly more occurrences
        if (candidate.score > existing.score) {
          selected[i] = candidate;
        }
        // else: existing has equal or higher score, discard candidate
        handled = true;
        break;
      }
    }

    if (!handled) {
      selected.push(candidate);
    }
  }

  return selected;
}

/** Return true if `descendant` is a strict descendant of `ancestor` (ancestor is a prefix). */
function isDescendant(descendant: string, ancestor: string): boolean {
  return descendant.startsWith(`${ancestor}/`);
}

/** Sum of occurrences of all keywords in a haystack string. */
function sumOccurrences(haystack: string, keywords: string[]): number {
  let total = 0;
  for (const kw of keywords) {
    total += occurrences(haystack, kw);
  }
  return total;
}

// ─── Node entries ─────────────────────────────────────────────────────────────

interface NodeEntries {
  nodos: MapaNode[];
  dedupeSet: Set<string>;
}

function buildNodeEntries(
  notes: GraphNote[],
  vocab: Vocabulary | null,
  scoredNodes: ScoredNode[],
  keywords: string[],
  maxNotesPerNode: number,
): NodeEntries {
  const dedupeSet = new Set<string>();
  const nodos: MapaNode[] = [];

  for (const { path } of scoredNodes) {
    const node = vocab?.nodes.get(path);

    // Collect notes in subtree (this node + all descendants)
    const subtreeNotes = getSubtreeNotes(notes, vocab, path);

    // Score each note
    const scored: Array<{ note: GraphNote; score: number }> = subtreeNotes
      .filter((n) => !dedupeSet.has(n.path))
      .map((note) => {
        const haystack = `${note.metadata.title} ${note.metadata.summary ?? ''}`
          .normalize('NFC')
          .toLowerCase();
        const kwHaystack = note.metadata.keywords.join(' ').toLowerCase();
        const base = sumOccurrences(haystack, keywords);
        const kw2 = sumOccurrences(kwHaystack, keywords);
        return { note, score: base + 2 * kw2 };
      })
      .sort((a, b) => {
        // score desc
        if (b.score !== a.score) return b.score - a.score;
        // date desc
        const da = a.note.metadata.date ?? '';
        const db = b.note.metadata.date ?? '';
        if (db > da) return 1;
        if (db < da) return -1;
        // path asc
        return stableCmp(a.note.path, b.note.path);
      })
      .slice(0, maxNotesPerNode);

    // Add to dedupeSet
    for (const { note } of scored) {
      dedupeSet.add(note.path);
    }

    const notas: MapaNoteItem[] = scored.map(({ note, score }) => ({
      titulo: note.metadata.title,
      ruta: note.path,
      type: note.metadata.type,
      ...(note.metadata.summary !== undefined && { summary: note.metadata.summary }),
      keywords: note.metadata.keywords,
      ...(note.metadata.work_item !== undefined && { workItem: note.metadata.work_item }),
      ...(note.metadata.date !== undefined && { date: note.metadata.date }),
      score,
    }));

    nodos.push({
      ruta: path,
      descripcion: node?.description ?? '',
      conteoSubarbol: countSubtree(notes, vocab, path),
      notas,
    });
  }

  return { nodos, dedupeSet };
}

/** Get all notes in the subtree of a vocab node (direct + all descendants). */
function getSubtreeNotes(
  notes: GraphNote[],
  vocab: Vocabulary | null,
  nodePath: string,
): GraphNote[] {
  if (!vocab) return notes.filter((n) => n.metadata.temas.includes(nodePath));

  // Collect node + all descendants
  const paths = new Set<string>();
  paths.add(nodePath);
  collectDescendants(vocab, nodePath, paths);

  return notes.filter((n) => n.metadata.temas.some((t) => paths.has(t)));
}

function collectDescendants(vocab: Vocabulary, path: string, out: Set<string>): void {
  for (const [nodePath, node] of vocab.nodes) {
    if (node.parent === path) {
      out.add(nodePath);
      collectDescendants(vocab, nodePath, out);
    }
  }
}

function countSubtree(notes: GraphNote[], vocab: Vocabulary | null, nodePath: string): number {
  const seen = new Set<string>();
  for (const note of getSubtreeNotes(notes, vocab, nodePath)) {
    seen.add(note.path);
  }
  return seen.size;
}

// ─── Work item entries ────────────────────────────────────────────────────────

function buildWorkItemEntries(
  notes: GraphNote[],
  task: string,
  dedupeSet: Set<string>,
): MapaWorkItem[] {
  const lowerTask = task.toLowerCase();
  const matches = [...lowerTask.matchAll(WORK_ITEM_RE)].map((m) => m[0] ?? '');
  if (matches.length === 0) return [];

  // Build a case-insensitive map: lowercase key → original displayed value.
  // If multiple notes share the same lowercase ID (e.g. HU-01 and hu-01), we
  // display the first original value we encounter.
  const workItemByLower = new Map<string, string>(); // lowercase → original
  for (const note of notes) {
    if (note.metadata.work_item) {
      const lower = note.metadata.work_item.toLowerCase().trim();
      if (!workItemByLower.has(lower)) workItemByLower.set(lower, note.metadata.work_item);
    }
  }

  const result: MapaWorkItem[] = [];

  for (const match of matches) {
    // `match` comes from lowercased task via WORK_ITEM_RE — compare case-insensitively.
    const originalId = workItemByLower.get(match);
    if (!originalId) continue;

    const lowerMatch = match; // already lowercase
    const matchNotes = notes.filter(
      (n) => n.metadata.work_item?.toLowerCase().trim() === lowerMatch,
    );
    if (matchNotes.length === 0) continue;

    const notas: MapaNoteItem[] = matchNotes.map((note) => ({
      titulo: note.metadata.title,
      ruta: note.path,
      type: note.metadata.type,
      ...(note.metadata.summary !== undefined && { summary: note.metadata.summary }),
      keywords: note.metadata.keywords,
      workItem: note.metadata.work_item, // keep original case for display
      ...(note.metadata.date !== undefined && { date: note.metadata.date }),
      score: 0,
    }));

    // Add to dedupe set (work_item notes are exempt from node dedupe but counted here)
    for (const note of matchNotes) dedupeSet.add(note.path);

    // Use the original (display) work item ID, not the lowercased match
    result.push({ id: originalId, notas });
  }

  return result;
}

// ─── Budget enforcement ───────────────────────────────────────────────────────

function enforceMapBudget(
  mapa: MapaStruct,
  budgetChars: number,
  notes: GraphNote[],
  vocab: Vocabulary | null,
  scoredNodes: ScoredNode[],
  keywords: string[],
): MapaStruct {
  let current = mapa;
  let section = renderMapaSection(current);

  if (section.length <= budgetChars) return current;

  // Try reducing notes per node: 5 → 4 → 3 → 2 → 1
  for (let maxNotes = MAX_NOTES_PER_NODE - 1; maxNotes >= 1; maxNotes--) {
    const { nodos } = buildNodeEntries(notes, vocab, scoredNodes, keywords, maxNotes);
    // Keep original work items (not re-scored)
    const newMapa: MapaStruct = { nodos, workItems: current.workItems, recortado: true };
    section = renderMapaSection(newMapa);
    if (section.length <= budgetChars) return newMapa;
    current = newMapa;
  }

  // Still too long: drop lowest-ranked nodes (keep ≥ 1)
  const orderedNodes = [...scoredNodes]; // already in score order (desc)
  while (current.nodos.length > 1) {
    const remaining = orderedNodes.filter((s) => current.nodos.some((n) => n.ruta === s.path));
    if (remaining.length <= 1) break;
    // Drop the last (lowest-ranked)
    const toKeep = remaining.slice(0, remaining.length - 1);
    const { nodos } = buildNodeEntries(notes, vocab, toKeep, keywords, 1);
    const newMapa: MapaStruct = { nodos, workItems: current.workItems, recortado: true };
    section = renderMapaSection(newMapa);
    if (section.length <= budgetChars) return newMapa;
    current = newMapa;
  }

  // Can't reduce further — mark recortado and return
  return { ...current, recortado: true };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/**
 * Render the `## Mapa del vault` section.
 *
 * Format:
 * ```
 * ## Mapa del vault
 *
 * ### Temas relevantes
 * - `lms/cursos/gestion` — Edición, publicación, archivado. · 7 notas
 *   - [título](ruta.md) — summary · claves: k1, k2 · type · date
 *   ...
 * ### Work item hu-lms-api-01
 * - [título](ruta.md) — summary · ...
 *
 * > (mapa recortado por presupuesto)   ← only when recortado=true
 *
 * Usa `chamba_vault_navigate` con `tema` o `path` para profundizar; lee cuerpos solo de las notas cuyo summary/keywords sean pertinentes.
 * ```
 */
function renderMapaSection(mapa: MapaStruct): string {
  const lines: string[] = ['## Mapa del vault', ''];

  if (mapa.nodos.length > 0) {
    lines.push('### Temas relevantes', '');
    for (const nodo of mapa.nodos) {
      const count = nodo.conteoSubarbol;
      const descPart = nodo.descripcion ? ` — ${nodo.descripcion}` : '';
      lines.push(`- \`${nodo.ruta}\`${descPart} · ${count} nota${count !== 1 ? 's' : ''}`);
      for (const nota of nodo.notas) {
        const parts: string[] = [];
        if (nota.summary) parts.push(nota.summary);
        if (nota.keywords.length > 0) parts.push(`claves: ${nota.keywords.join(', ')}`);
        parts.push(nota.type);
        if (nota.date) parts.push(nota.date);
        const detail = parts.join(' · ');
        lines.push(`  - [${nota.titulo}](${nota.ruta})${detail ? ` — ${detail}` : ''}`);
      }
    }
  }

  // A work-item note already listed under a topic is referenced, not repeated.
  const listed = new Set(mapa.nodos.flatMap((n) => n.notas.map((nota) => nota.ruta)));
  for (const wi of mapa.workItems) {
    lines.push('', `### Work item ${wi.id}`, '');
    for (const nota of wi.notas) {
      if (listed.has(nota.ruta)) {
        lines.push(`- [${nota.titulo}](${nota.ruta}) (listada arriba)`);
        continue;
      }
      const parts: string[] = [];
      if (nota.summary) parts.push(nota.summary);
      if (nota.keywords.length > 0) parts.push(`claves: ${nota.keywords.join(', ')}`);
      parts.push(nota.type);
      if (nota.date) parts.push(nota.date);
      const detail = parts.join(' · ');
      lines.push(`- [${nota.titulo}](${nota.ruta})${detail ? ` — ${detail}` : ''}`);
    }
  }

  if (mapa.recortado) {
    lines.push('', '> (mapa recortado por presupuesto)');
  }

  lines.push(
    '',
    'Usa `chamba_vault_navigate` con `tema` o `path` para profundizar; lee cuerpos solo de las notas cuyo summary/keywords sean pertinentes.',
  );

  return lines.join('\n');
}
