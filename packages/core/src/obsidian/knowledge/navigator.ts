/**
 * obsidian/knowledge/navigator.ts — in-memory vault navigation model.
 *
 * `buildVaultNav(notes, vocab)` → `VaultNav`
 * `navRoot(nav)` → `NavRootView`     (top-level topics + folders)
 * `navNode(nav, path)` → `NavNodeView | null`   (subtopics + direct notes + co-topics)
 * `navNote(nav, notes, path, opts?)` → `NavNoteView | null` (metadata + backlinks + sisters)
 * `coTopics(nav, node)` → `CoTopic[]`  (co-occurring topics for a node's subtree)
 *
 * Pure TypeScript: no `node:` imports, no external dependencies, no IO.
 * Uses `sortNotes` and `stableCmp` from knowledge-graph.ts.
 */

import { type GraphNote, sortNotes, stableCmp } from './knowledge-graph.js';
import { esCanonico, type NoteType } from './note-metadata.js';
import { ancestors, children, type Vocabulary } from './vocabulary.js';

// ─── Public types ─────────────────────────────────────────────────────────────

export interface VaultNavNode {
  /** Topic path, e.g. `lms/cursos`. */
  ruta: string;
  descripcion: string;
  aliases: string[];
  parent: string | null;
  /** Count of notes in the subtree (this node + all descendants). Deduped. */
  conteoSubarbol: number;
  /** Notes whose `temas` directly includes this exact path. Sorted by sortNotes. */
  notasDirectas: GraphNote[];
  /** Direct child topic paths. */
  subtemas: string[];
}

export interface VaultNav {
  /** All topic nodes from the vocabulary. */
  nodes: Map<string, VaultNavNode>;
  /** Root-level topic paths (nodes without parent), sorted. */
  nodosRaiz: string[];
  /** Physical folders (not under temas/) that contain notes. */
  carpetas: { ruta: string; conteo: number }[];
  /** Count of notes that have no valid temas. */
  sinClasificar: number;
}

export interface NavRootView {
  temas: { ruta: string; descripcion: string; aliases: string[]; conteoSubarbol: number }[];
  carpetas: { ruta: string; conteo: number }[];
  sinClasificar: number;
}

export interface NavNodeItem {
  titulo: string;
  ruta: string;
  type: NoteType;
  summary?: string;
  keywords: string[];
  temas: string[];
  workItem?: string;
  date?: string;
  /** CHAMBA-021 S13: present only for a note pending human review. */
  estado?: 'propuesto';
  author?: string;
}

export interface CoTopic {
  tema: string;
  conteo: number;
}

export interface NavNodeView {
  ruta: string;
  descripcion: string;
  padre?: string;
  subtemas: { ruta: string; descripcion: string; conteoSubarbol: number }[];
  notasDirectas: NavNodeItem[];
  coTemas: CoTopic[];
}

export interface BacklinkItem {
  titulo: string;
  ruta: string;
}

export interface NavNoteView {
  ruta: string;
  titulo: string;
  temas: string[];
  keywords: string[];
  type: NoteType;
  workItem?: string;
  related: string[];
  date?: string;
  summary?: string;
  backlinks: BacklinkItem[];
  hermanas: NavNodeItem[];
  body?: string;
  truncated?: boolean;
  /** CHAMBA-021 S13: present only for a note pending human review. */
  estado?: 'propuesto';
  author?: string;
}

// ─── buildVaultNav ────────────────────────────────────────────────────────────

/**
 * Build the in-memory navigation model from a list of notes and a vocabulary.
 *
 * @param notes - All notes in the vault (vault-relative paths, `/`-separated).
 * @param vocab - Parsed vocabulary, or `null` if the vault has no vocabulary.
 */
export function buildVaultNav(notes: GraphNote[], vocab: Vocabulary | null): VaultNav {
  const nodes = new Map<string, VaultNavNode>();

  if (vocab) {
    for (const [path, topicNode] of vocab.nodes) {
      nodes.set(path, {
        ruta: path,
        descripcion: topicNode.description,
        aliases: topicNode.aliases,
        parent: topicNode.parent,
        conteoSubarbol: 0,
        notasDirectas: [],
        subtemas: children(vocab, path),
      });
    }
  }

  // Track subtree note sets (for deduped conteoSubarbol)
  const subtreeNotePaths = new Map<string, Set<string>>();
  for (const path of nodes.keys()) {
    subtreeNotePaths.set(path, new Set());
  }

  let sinClasificar = 0;

  for (const note of notes) {
    const validTemas = vocab ? note.metadata.temas.filter((t) => vocab.nodes.has(t)) : [];

    if (validTemas.length === 0) {
      sinClasificar++;
      continue;
    }

    // Add to direct notes for each matching tema
    for (const tema of validTemas) {
      nodes.get(tema)?.notasDirectas.push(note);
    }

    // Add to subtree for each tema AND all its ancestors (deduped per note)
    const affectedNodes = new Set<string>();
    for (const tema of validTemas) {
      affectedNodes.add(tema);
      for (const anc of ancestors(tema)) {
        if (nodes.has(anc)) affectedNodes.add(anc);
      }
    }
    for (const nodePath of affectedNodes) {
      subtreeNotePaths.get(nodePath)?.add(note.path);
    }
  }

  // Apply subtree counts and sort direct notes
  for (const [path, noteSet] of subtreeNotePaths) {
    const node = nodes.get(path);
    if (node) {
      node.conteoSubarbol = noteSet.size;
      node.notasDirectas = sortNotes(node.notasDirectas);
    }
  }

  // Root-level topics (no parent), sorted
  const nodosRaiz = [...nodes.values()]
    .filter((n) => n.parent === null)
    .map((n) => n.ruta)
    .sort(stableCmp);

  // Physical folders (non-temas directories with notes)
  const carpetaMap = new Map<string, number>();
  for (const note of notes) {
    const parts = note.path.split('/');
    if (parts.length >= 2) {
      const dir = parts[0] ?? '';
      if (dir && dir !== 'temas') {
        carpetaMap.set(dir, (carpetaMap.get(dir) ?? 0) + 1);
      }
    }
  }
  const carpetas = [...carpetaMap.entries()]
    .sort(([a], [b]) => stableCmp(a, b))
    .map(([ruta, conteo]) => ({ ruta, conteo }));

  return { nodes, nodosRaiz, carpetas, sinClasificar };
}

// ─── navRoot ──────────────────────────────────────────────────────────────────

/** Return the root-level navigation view: top-level topics, folders, and unclassified count. */
export function navRoot(nav: VaultNav): NavRootView {
  const temas = nav.nodosRaiz.map((ruta) => {
    const node = nav.nodes.get(ruta);
    return {
      ruta,
      descripcion: node?.descripcion ?? '',
      aliases: node?.aliases ?? [],
      conteoSubarbol: node?.conteoSubarbol ?? 0,
    };
  });
  return { temas, carpetas: nav.carpetas, sinClasificar: nav.sinClasificar };
}

// ─── navNode ──────────────────────────────────────────────────────────────────

/**
 * Return the navigation view for a specific topic node.
 * Returns `null` when the node is not found in the nav.
 */
export function navNode(nav: VaultNav, path: string): NavNodeView | null {
  const node = nav.nodes.get(path);
  if (!node) return null;

  const subtemas = node.subtemas.map((childPath) => {
    const child = nav.nodes.get(childPath);
    return {
      ruta: childPath,
      descripcion: child?.descripcion ?? '',
      conteoSubarbol: child?.conteoSubarbol ?? 0,
    };
  });

  const notasDirectas = node.notasDirectas.map(noteToNavItem);

  return {
    ruta: node.ruta,
    descripcion: node.descripcion,
    ...(node.parent !== null && { padre: node.parent }),
    subtemas,
    notasDirectas,
    coTemas: coTopics(nav, node),
  };
}

// ─── coTopics ─────────────────────────────────────────────────────────────────

/**
 * Compute co-occurring topics for a node's subtree.
 *
 * Returns the top 5 temas (not the node itself or its descendants) that
 * co-occur in the notes of the node's subtree, sorted by count desc, path asc.
 */
export function coTopics(nav: VaultNav, node: VaultNavNode): CoTopic[] {
  // Collect all notes in subtree
  const subtreeNotes = getSubtreeNotes(nav, node.ruta);

  // All descendant paths (including self)
  const ownAndDesc = new Set([node.ruta, ...getDescendants(nav, node.ruta)]);

  const topicCounts = new Map<string, number>();
  for (const n of subtreeNotes) {
    for (const tema of n.metadata.temas) {
      if (!ownAndDesc.has(tema)) {
        topicCounts.set(tema, (topicCounts.get(tema) ?? 0) + 1);
      }
    }
  }

  return [...topicCounts.entries()]
    .sort(([a, ca], [b, cb]) => cb - ca || stableCmp(a, b))
    .slice(0, 5)
    .map(([tema, conteo]) => ({ tema, conteo }));
}

// ─── navNote ──────────────────────────────────────────────────────────────────

export interface NavNoteOptions {
  /** Include the note body in the result (default false). */
  readBody?: boolean;
  /** Max chars for the body before truncation (default 4000, max 20000). */
  maxChars?: number;
  /**
   * Note bodies keyed by vault-relative path. Required for body-based backlink
   * detection (links in body text). If omitted, only metadata `related` field
   * backlinks are computed.
   */
  noteContents?: Map<string, string>;
}

/**
 * Return the note-level navigation view.
 *
 * @param nav        - Vault navigation model.
 * @param notes      - All notes (for sisters and backlink resolution).
 * @param notePath   - Vault-relative path of the note to view.
 * @param opts       - Options for body reading and backlink computation.
 * @returns `NavNoteView` or `null` when the note is not found.
 */
export function navNote(
  _nav: VaultNav,
  notes: GraphNote[],
  notePath: string,
  opts: NavNoteOptions = {},
): NavNoteView | null {
  const note = notes.find((n) => n.path === notePath);
  if (!note) return null;

  const { readBody = false, maxChars = 4000, noteContents } = opts;
  const effectiveMaxChars = Math.min(maxChars, 20000);

  // ── Backlinks ───────────────────────────────────────────────────────────────
  const backlinkPaths = new Set<string>();
  const backlinks: BacklinkItem[] = [];

  for (const other of notes) {
    if (other.path === notePath) continue;

    // 1. Check metadata `related` field
    for (const ref of other.metadata.related) {
      if (resolveRelatedRef(ref, notePath, notes)) {
        if (!backlinkPaths.has(other.path)) {
          backlinkPaths.add(other.path);
          backlinks.push({ titulo: other.metadata.title, ruta: other.path });
        }
        break;
      }
    }

    // 2. Check body links (wiki links + markdown links)
    if (!backlinkPaths.has(other.path) && noteContents) {
      const body = noteContents.get(other.path);
      if (body) {
        // Wiki links: [[dest]], [[dest|alias]], [[dest#heading]]
        const wikiMatches = [...body.matchAll(/\[\[([^\]]+)\]\]/g)];
        let found = false;
        for (const m of wikiMatches) {
          const resolved = resolveWikiLink(m[1] ?? '', other.path, notes);
          if (resolved === notePath) {
            found = true;
            break;
          }
        }
        // Markdown links: [text](url)
        if (!found) {
          const mdMatches = [...body.matchAll(/\[(?:[^\]]*)\]\(([^)]+)\)/g)];
          for (const m of mdMatches) {
            const resolved = resolveMdLink(m[1] ?? '', other.path);
            if (resolved === notePath) {
              found = true;
              break;
            }
          }
        }
        if (found) {
          backlinkPaths.add(other.path);
          backlinks.push({ titulo: other.metadata.title, ruta: other.path });
        }
      }
    }
  }

  // Sort backlinks by ruta asc
  backlinks.sort((a, b) => stableCmp(a.ruta, b.ruta));

  // ── Sisters (same work_item, excluding self) ────────────────────────────────
  const workItem = note.metadata.work_item;
  const hermanas: NavNodeItem[] = workItem
    ? sortNotes(notes.filter((n) => n.path !== notePath && n.metadata.work_item === workItem)).map(
        noteToNavItem,
      )
    : [];

  // ── Build result ────────────────────────────────────────────────────────────
  const result: NavNoteView = {
    ruta: notePath,
    titulo: note.metadata.title,
    temas: note.metadata.temas,
    keywords: note.metadata.keywords,
    type: note.metadata.type,
    ...(workItem !== undefined && { workItem }),
    related: note.metadata.related,
    ...(note.metadata.date !== undefined && { date: note.metadata.date }),
    ...(note.metadata.summary !== undefined && { summary: note.metadata.summary }),
    backlinks,
    hermanas,
    ...(!esCanonico(note.metadata) && { estado: 'propuesto' as const }),
    ...(note.metadata.author !== undefined && { author: note.metadata.author }),
  };

  // ── Body ────────────────────────────────────────────────────────────────────
  if (readBody && noteContents) {
    const body = noteContents.get(notePath);
    if (body !== undefined) {
      if (body.length > effectiveMaxChars) {
        result.body = `${body.slice(0, effectiveMaxChars)}\n\n> (cuerpo recortado)`;
        result.truncated = true;
      } else {
        result.body = body;
      }
    }
  }

  return result;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function noteToNavItem(note: GraphNote): NavNodeItem {
  return {
    titulo: note.metadata.title,
    ruta: note.path,
    type: note.metadata.type,
    ...(note.metadata.summary !== undefined && { summary: note.metadata.summary }),
    keywords: note.metadata.keywords,
    temas: note.metadata.temas,
    ...(note.metadata.work_item !== undefined && { workItem: note.metadata.work_item }),
    ...(note.metadata.date !== undefined && { date: note.metadata.date }),
    ...(!esCanonico(note.metadata) && { estado: 'propuesto' as const }),
    ...(note.metadata.author !== undefined && { author: note.metadata.author }),
  };
}

/** All notes in the subtree of a node (direct notes of node + all descendants). */
function getSubtreeNotes(nav: VaultNav, nodePath: string): GraphNote[] {
  const result: GraphNote[] = [];
  const seen = new Set<string>();

  const addNotes = (path: string): void => {
    const node = nav.nodes.get(path);
    if (!node) return;
    for (const note of node.notasDirectas) {
      if (!seen.has(note.path)) {
        seen.add(note.path);
        result.push(note);
      }
    }
    for (const child of node.subtemas) {
      addNotes(child);
    }
  };

  addNotes(nodePath);
  return result;
}

/** All descendant paths of a node (not including itself). */
function getDescendants(nav: VaultNav, nodePath: string): string[] {
  const result: string[] = [];
  const node = nav.nodes.get(nodePath);
  if (!node) return result;

  for (const child of node.subtemas) {
    result.push(child);
    result.push(...getDescendants(nav, child));
  }
  return result;
}

/**
 * Check if a `related` field value references `targetPath`.
 *
 * Handles:
 * - Wiki links: `[[dest]]`, `[[dest|alias]]`, `[[dest#heading]]`
 * - Direct paths (with or without `.md`)
 */
function resolveRelatedRef(ref: string, targetPath: string, allNotes: GraphNote[]): boolean {
  const r = ref.trim();

  // Wiki link format: [[dest]] or [[dest|alias]] or [[dest#h]]
  const wikiMatch = r.match(/^\[\[([^\]]+)\]\]$/);
  if (wikiMatch) {
    const resolved = resolveWikiLink(wikiMatch[1] ?? '', '', allNotes);
    return resolved === targetPath;
  }

  // Direct path (with or without .md)
  const withMd = r.endsWith('.md') ? r : `${r}.md`;
  if (withMd === targetPath || r === targetPath) return true;

  return false;
}

/**
 * Resolve a wiki link target to a vault-relative path.
 *
 * Rules (§16 M2):
 * - `[[dest]]`, `[[dest|alias]]`, `[[dest#heading]]` → strip alias/heading.
 * - If `dest` contains `/`: vault-relative path (add `.md` if missing).
 * - If `dest` has no `/`: match by basename, but only if unique in vault.
 *
 * Returns the resolved path, or `null` if unresolvable.
 */
function resolveWikiLink(link: string, _fromPath: string, allNotes: GraphNote[]): string | null {
  // Strip alias: [[dest|alias]] → dest
  const withoutAlias = link.split('|')[0] ?? link;
  // Strip heading: [[dest#h]] → dest
  const dest = (withoutAlias.split('#')[0] ?? withoutAlias).trim();

  if (dest.length === 0) return null;

  if (dest.includes('/')) {
    // Vault-relative path
    const withMd = dest.endsWith('.md') ? dest : `${dest}.md`;
    return withMd.startsWith('/') ? withMd.slice(1) : withMd;
  }

  // Basename match — only if unique
  const target = dest.endsWith('.md') ? dest : `${dest}.md`;
  const matches = allNotes.filter((n) => {
    const base = n.path.split('/').pop() ?? '';
    return base === target;
  });
  return matches.length === 1 ? (matches[0]?.path ?? null) : null;
}

/**
 * Resolve a markdown link `[text](url)` to a vault-relative path.
 *
 * Rules (§16 M2):
 * - Ignore URLs with a scheme (http://, https://, etc.).
 * - If url starts with `/`: treat as vault-absolute (strip leading `/`).
 * - Otherwise: relative to the note's directory.
 *
 * Returns `null` for external URLs or if no valid resolution.
 */
function resolveMdLink(url: string, fromPath: string): string | null {
  const u = url.trim();
  // Ignore external URLs
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return null;
  // Skip fragment-only links
  if (u.startsWith('#')) return null;

  if (u.startsWith('/')) {
    // Vault-absolute
    return u.slice(1);
  }

  // Relative to note's directory
  const dir = fromPath.includes('/') ? fromPath.slice(0, fromPath.lastIndexOf('/')) : '';
  return dir ? `${dir}/${u}` : u;
}
