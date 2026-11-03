/**
 * obsidian/knowledge/vocabulary.ts — parser and utilities for
 * `temas/VOCABULARIO.md`, the per-workspace topic vocabulary.
 * Pure TypeScript: no `node:` imports, no external dependencies.
 *
 * Entry format in the body:
 *   - `ruta/del/tema` — Descripción breve. Alias: alias1, alias2
 *     - `ruta/del/tema/hijo` — Descripción.
 *
 * The path is authoritative (indentation is only visual). Every segment
 * must match `^[a-z0-9]+(-[a-z0-9]+)*$`. Max depth: 4 levels.
 * Every declared node must have its parent declared first.
 * Aliases (and the last segment itself) must be unique across the vocabulary.
 */

import type { NoteMetadata, NoteType } from './note-metadata.js';

export type { NoteMetadata, NoteType };

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TopicNode {
  /** Full slash-separated path, e.g. `lms/cursos/creacion`. */
  path: string;
  description: string;
  aliases: string[];
  /** Parent path or `null` for root nodes. */
  parent: string | null;
}

export interface Vocabulary {
  /** All valid nodes, keyed by path. */
  nodes: Map<string, TopicNode>;
  /** Minimum note count for a proposed topic to be flagged for promotion. */
  umbral_promover: number;
  /** Maximum direct-note count before a node is flagged for splitting. */
  umbral_dividir: number;
  /** Whether to generate `.base` Bases files. */
  generar_bases: boolean;
}

export interface VocabularyError {
  /** Short machine-readable code. */
  code:
    | 'INVALID_SEGMENT'
    | 'DEPTH_EXCEEDED'
    | 'MISSING_PARENT'
    | 'DUPLICATE_PATH'
    | 'DUPLICATE_ALIAS'
    | 'INDENT_MISMATCH';
  /** Human-readable explanation. */
  message: string;
  /** The raw path string from the source line, if available. */
  path?: string;
}

export type ResolveTopicResult = { path: string } | { unknown: string; suggestions: string[] };

// ─── Segment validation ───────────────────────────────────────────────────────

const SEGMENT_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function validateSegments(path: string): string | null {
  const segments = path.split('/');
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg)) {
      return `Invalid segment "${seg}" in path "${path}": must match ^[a-z0-9]+(-[a-z0-9]+)*$`;
    }
  }
  return null;
}

function pathDepth(path: string): number {
  return path.split('/').length;
}

function parentPath(path: string): string | null {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? null : path.slice(0, idx);
}

// ─── Frontmatter parsing (reused from note-metadata, minimal subset) ──────────

function stripCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

interface VocabFrontmatter {
  umbral_promover: number;
  umbral_dividir: number;
  generar_bases: boolean;
  /** Validation errors from frontmatter parsing (M12: non-integer umbrales). */
  fmErrors: VocabularyError[];
}

function parseVocabFrontmatter(content: string): VocabFrontmatter {
  const defaults: VocabFrontmatter = {
    umbral_promover: 3,
    umbral_dividir: 25,
    generar_bases: true,
    fmErrors: [],
  };

  const lines = content.split('\n');
  if (stripCR(lines[0] ?? '') !== '---') return defaults;

  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (stripCR(lines[i] ?? '') === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return defaults;

  const fmLines = lines.slice(1, closeIdx);
  let umbral_promover = defaults.umbral_promover;
  let umbral_dividir = defaults.umbral_dividir;
  let generar_bases = defaults.generar_bases;
  const fmErrors: VocabularyError[] = [];

  for (const rawLine of fmLines) {
    const line = stripCR(rawLine);
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const rawVal = line.slice(colonIdx + 1).trim();

    if (key === 'umbral_promover') {
      const parsed = Number(rawVal);
      if (Number.isNaN(parsed)) {
        // Unparseable — skip
      } else if (!Number.isInteger(parsed)) {
        // M12: non-integer → use default and report error
        fmErrors.push({
          code: 'INVALID_SEGMENT',
          message: `umbral_promover debe ser un entero; se usará el valor por defecto (${defaults.umbral_promover}). Valor recibido: ${rawVal}`,
        });
      } else {
        umbral_promover = parsed;
      }
    } else if (key === 'umbral_dividir') {
      const parsed = Number(rawVal);
      if (Number.isNaN(parsed)) {
        // Unparseable — skip
      } else if (!Number.isInteger(parsed)) {
        // M12: non-integer → use default and report error
        fmErrors.push({
          code: 'INVALID_SEGMENT',
          message: `umbral_dividir debe ser un entero; se usará el valor por defecto (${defaults.umbral_dividir}). Valor recibido: ${rawVal}`,
        });
      } else {
        umbral_dividir = parsed;
      }
    } else if (key === 'generar_bases') {
      if (rawVal === 'false' || rawVal === 'no') generar_bases = false;
      else if (rawVal === 'true' || rawVal === 'yes') generar_bases = true;
    }
  }

  return { umbral_promover, umbral_dividir, generar_bases, fmErrors };
}

/** Return body lines (after closing `---` of frontmatter, or full content if no frontmatter). */
function bodyLines(content: string): string[] {
  const lines = content.split('\n');
  if (stripCR(lines[0] ?? '') !== '---') return lines;
  for (let i = 1; i < lines.length; i++) {
    if (stripCR(lines[i] ?? '') === '---') {
      return lines.slice(i + 1);
    }
  }
  return lines; // unclosed frontmatter → treat entire content as body
}

// ─── Entry line parsing ───────────────────────────────────────────────────────

/** Em dash variants (U+2014 and ASCII `---` not used here; only true em dash). */
const EM_DASH = '—';

interface ParsedLine {
  path: string;
  description: string;
  aliases: string[];
  /** Count of leading spaces (tabs = 4 spaces). */
  indentSpaces: number;
}

function parseEntryLine(rawLine: string): ParsedLine | null {
  const line = stripCR(rawLine);

  // Count indentation (tabs count as 4 spaces; we count actual spaces/tabs)
  let indentSpaces = 0;
  let pos = 0;
  while (pos < line.length && (line[pos] === ' ' || line[pos] === '\t')) {
    indentSpaces += line[pos] === '\t' ? 4 : 1;
    pos++;
  }

  const rest = line.slice(pos);
  // Must start with `- ` followed by a backtick-enclosed path
  if (!rest.startsWith('- `')) return null;

  const afterDash = rest.slice(2); // strip `- `
  if (!afterDash.startsWith('`')) return null;

  const closeBt = afterDash.indexOf('`', 1);
  if (closeBt === -1) return null;

  const path = afterDash.slice(1, closeBt);
  const afterPath = afterDash.slice(closeBt + 1).trimStart();

  let description = '';
  let aliases: string[] = [];

  if (afterPath.startsWith(EM_DASH)) {
    const descRaw = afterPath.slice(EM_DASH.length).trimStart();
    // Split on `. Alias: ` or `. Aliases: ` (case-insensitive)
    const aliasMatch = descRaw.match(/^(.*?)\.\s+[Aa]lias(?:es?)?:\s+(.+)$/);
    if (aliasMatch) {
      description = (aliasMatch[1] ?? '').trim();
      aliases = (aliasMatch[2] ?? '')
        .split(',')
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a !== '');
    } else {
      // No aliases — description is everything (strip trailing `.` if present)
      description = descRaw.endsWith('.') ? descRaw.slice(0, -1).trim() : descRaw.trim();
    }
  }

  return { path, description, aliases, indentSpaces };
}

// ─── Public: parseVocabulary ─────────────────────────────────────────────────

/**
 * Parse `temas/VOCABULARIO.md` content into a `Vocabulary` and a list of errors.
 * Invalid nodes are excluded from the vocabulary; errors are reported but not thrown.
 */
export function parseVocabulary(content: string): {
  vocabulary: Vocabulary;
  errors: VocabularyError[];
} {
  const fm = parseVocabFrontmatter(content);
  const lines = bodyLines(content);
  // M12: propagate frontmatter errors (non-integer umbrales, etc.)
  const errors: VocabularyError[] = [...fm.fmErrors];

  const nodes = new Map<string, TopicNode>();
  // Map from alias/slug to the canonical path that claimed it (for uniqueness)
  const aliasIndex = new Map<string, string>();

  // Detect base indent unit (first indented entry)
  let baseIndent = 0;
  for (const rawLine of lines) {
    const parsed = parseEntryLine(rawLine);
    if (!parsed) continue;
    if (parsed.indentSpaces > 0 && baseIndent === 0) {
      baseIndent = parsed.indentSpaces;
    }
  }
  if (baseIndent === 0) baseIndent = 2; // fallback

  for (const rawLine of lines) {
    const parsed = parseEntryLine(rawLine);
    if (!parsed) continue;

    const { path, description, aliases, indentSpaces } = parsed;

    // Validate segments
    const segErr = validateSegments(path);
    if (segErr !== null) {
      errors.push({ code: 'INVALID_SEGMENT', message: segErr, path });
      continue;
    }

    // Validate depth ≤ 4
    const depth = pathDepth(path);
    if (depth > 4) {
      errors.push({
        code: 'DEPTH_EXCEEDED',
        message: `Path "${path}" has depth ${depth} which exceeds the maximum of 4.`,
        path,
      });
      continue;
    }

    // Validate parent is declared
    const parent = parentPath(path);
    if (parent !== null && !nodes.has(parent)) {
      errors.push({
        code: 'MISSING_PARENT',
        message: `Path "${path}" references parent "${parent}" which has not been declared.`,
        path,
      });
      continue;
    }

    // Validate no duplicate path
    if (nodes.has(path)) {
      errors.push({
        code: 'DUPLICATE_PATH',
        message: `Path "${path}" is declared more than once.`,
        path,
      });
      continue;
    }

    // Validate alias uniqueness (including slug = last segment)
    const lastSegment = path.split('/').pop() ?? path;
    const allAliasesForNode = [lastSegment, ...aliases];
    let aliasConflict = false;

    for (const alias of allAliasesForNode) {
      const existing = aliasIndex.get(alias);
      if (existing !== undefined && existing !== path) {
        errors.push({
          code: 'DUPLICATE_ALIAS',
          message: `Alias or slug "${alias}" in "${path}" conflicts with "${existing}".`,
          path,
        });
        aliasConflict = true;
        break;
      }
    }
    if (aliasConflict) continue;

    // Check indent consistency
    const expectedIndent = (depth - 1) * baseIndent;
    if (indentSpaces !== expectedIndent) {
      errors.push({
        code: 'INDENT_MISMATCH',
        message: `Path "${path}" (depth ${depth}) has indent ${indentSpaces} but expected ${expectedIndent} (${baseIndent}-space units). The path hierarchy is used anyway.`,
        path,
      });
      // Do NOT skip — indent mismatch is just a warning; the path is still added
    }

    // Register aliases
    for (const alias of allAliasesForNode) {
      aliasIndex.set(alias, path);
    }
    // Also register the full path as a resolvable key
    aliasIndex.set(path, path);

    nodes.set(path, {
      path,
      description,
      aliases,
      parent,
    });
  }

  return {
    vocabulary: {
      nodes,
      umbral_promover: fm.umbral_promover,
      umbral_dividir: fm.umbral_dividir,
      generar_bases: fm.generar_bases,
    },
    errors,
  };
}

// ─── Public: resolveTopic ─────────────────────────────────────────────────────

/**
 * Resolve an input string to a canonical vocabulary path.
 *
 * - Exact path match (`lms/cursos`) → `{ path }`.
 * - Alias match (`plataforma`) → canonical path.
 * - Strips leading `tema/` prefix before trying.
 * - Case-insensitive comparison.
 * - If no match → `{ unknown, suggestions }` with Levenshtein ≤ 2 on slugs/paths/aliases.
 */
export function resolveTopic(vocab: Vocabulary, input: string): ResolveTopicResult {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/^tema\//, '');

  // Check exact path
  if (vocab.nodes.has(normalized)) {
    return { path: normalized };
  }

  // Build alias→path index from vocab
  const aliasMap = buildAliasMap(vocab);

  // Check alias/slug
  const byAlias = aliasMap.get(normalized);
  if (byAlias !== undefined) {
    return { path: byAlias };
  }

  // Not found — suggest by edit distance
  const candidates = buildCandidates(vocab);
  const suggestions = candidates
    .map((c) => ({ c, d: editDistance(normalized, c) }))
    .filter(({ d }) => d <= 2)
    .sort((a, b) => a.d - b.d || a.c.localeCompare(b.c))
    .map(({ c }) => c);

  // Deduplicate suggestions (aliases → canonical paths)
  const seenPaths = new Set<string>();
  const uniqueSuggestions: string[] = [];
  for (const s of suggestions) {
    const canonical = aliasMap.get(s) ?? (vocab.nodes.has(s) ? s : undefined);
    if (canonical === undefined) continue;
    if (!seenPaths.has(canonical)) {
      seenPaths.add(canonical);
      uniqueSuggestions.push(canonical);
    }
  }

  return { unknown: input, suggestions: uniqueSuggestions.slice(0, 5) };
}

/** Build a map from alias/slug/path → canonical path. */
function buildAliasMap(vocab: Vocabulary): Map<string, string> {
  const map = new Map<string, string>();
  for (const node of vocab.nodes.values()) {
    map.set(node.path, node.path);
    const lastSeg = node.path.split('/').pop() ?? node.path;
    map.set(lastSeg, node.path);
    for (const alias of node.aliases) {
      map.set(alias.toLowerCase(), node.path);
    }
  }
  return map;
}

/** All searchable strings for suggestion matching. */
function buildCandidates(vocab: Vocabulary): string[] {
  const candidates: string[] = [];
  for (const node of vocab.nodes.values()) {
    candidates.push(node.path);
    const lastSeg = node.path.split('/').pop() ?? node.path;
    candidates.push(lastSeg);
    for (const alias of node.aliases) {
      candidates.push(alias);
    }
  }
  return [...new Set(candidates)];
}

// ─── Public: ancestors ───────────────────────────────────────────────────────

/**
 * Return all ancestor paths of `path` in order from root to immediate parent.
 * E.g. `ancestors('lms/cursos/creacion')` → `['lms', 'lms/cursos']`.
 */
export function ancestors(path: string): string[] {
  const parts = path.split('/');
  const result: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    result.push(parts.slice(0, i).join('/'));
  }
  return result;
}

// ─── Public: children ────────────────────────────────────────────────────────

/**
 * Return the direct children paths of `path` in the vocabulary.
 */
export function children(vocab: Vocabulary, path: string): string[] {
  const result: string[] = [];
  for (const node of vocab.nodes.values()) {
    if (node.parent === path) {
      result.push(node.path);
    }
  }
  return result.sort();
}

// ─── Public: editDistance ────────────────────────────────────────────────────

/**
 * Levenshtein edit distance between two strings (case-sensitive).
 */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  // Use a flat array [row*(n+1)+col] to avoid per-row array indexing issues.
  const size = (m + 1) * (n + 1);
  const dp = new Int32Array(size);

  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    dp[i * (n + 1)] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const sub = dp[(i - 1) * (n + 1) + (j - 1)];
      const del = dp[(i - 1) * (n + 1) + j];
      const ins = dp[i * (n + 1) + (j - 1)];
      dp[i * (n + 1) + j] =
        sub === undefined || del === undefined || ins === undefined
          ? 0
          : cost === 0
            ? sub
            : 1 + Math.min(sub, del, ins);
    }
  }
  return dp[m * (n + 1) + n] ?? 0;
}

// ─── Public: emptyVocabularyTemplate ─────────────────────────────────────────

/**
 * Return the content of an empty `VOCABULARIO.md` file with frontmatter and
 * instructions for the human. Never invents topics.
 */
export function emptyVocabularyTemplate(): string {
  return [
    '---',
    'title: "Vocabulario de temas"',
    'source: human',
    'umbral_promover: 3',
    'umbral_dividir: 25',
    'generar_bases: true',
    '---',
    '# Vocabulario de temas',
    '',
    '> **Formato de cada línea:**',
    '> `` - `ruta/del/tema` — Descripción breve. Alias: alias1, alias2 ``',
    '> Indenta los hijos con 2 espacios respecto al padre.',
    '>',
    '> **Reglas:**',
    '> - Rutas: segmentos en minúsculas con números y guiones (ej: `lms`, `cursos-avanzados`).',
    '> - Profundidad máxima: 4 niveles (ej: `area/sub/topico/detalle`).',
    '> - Todo nodo debe tener su padre declarado ANTES.',
    '> - Aliases únicos en todo el vocabulario (incluidos los slugs de cada nodo).',
    '> - chamba no inventa temas. Define aquí los que necesitas.',
    '>',
    '> **Umbrales** (editables en el frontmatter):',
    '> - `umbral_promover`: temas propuestos con ≥ N notas se ofrecen para aprobar.',
    '> - `umbral_dividir`: nodos con > N notas directas se ofrecen para dividir.',
    '> - `generar_bases: false` desactiva la creación de archivos `.base`.',
    '>',
    '> Borra este bloque y agrega tus temas a continuación.',
    '',
  ].join('\n');
}
