/**
 * vault-sync/conflict.ts — conflict copy path naming and frontmatter helpers.
 * Pure: no Node APIs, no LLM.
 */

import { basename, dirname, extname, joinPath } from '../util/path.js';
import { joinFrontmatter, readScalar, splitFrontmatter, upsertScalar } from './frontmatter.js';

// ─── Author sanitization ───────────────────────────────────────────────────────

/**
 * Sanitize an author string for use in a conflict copy name:
 * - NFD-decompose + strip combining diacritical marks
 * - lowercase
 * - replace non [a-z0-9._-] sequences with `-`
 * - trim leading/trailing `-` and `.`
 * - empty result → `anon`
 */
export function sanitizeAuthor(author: string): string {
  const decomposed = author.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const lowered = decomposed.toLowerCase();
  const replaced = lowered.replace(/[^a-z0-9._-]+/g, '-');
  const trimmed = replaced.replace(/^[-.]+|[-.]+$/g, '');
  return trimmed.length > 0 ? trimmed : 'anon';
}

// ─── Conflict copy path (D3) ──────────────────────────────────────────────────

/**
 * Generate a unique conflict copy path for `path` authored by `author`.
 * Format: `dir/stem (conflicto <sanitized-author>[ N]).ext`
 * Starts unnumbered (N omitted), then 2, 3, …
 * `existing` is the set of already-used paths (grows as the plan is built).
 */
export function conflictCopyPath(path: string, author: string, existing: Set<string>): string {
  const dir = dirname(path);
  const ext = extname(path);
  const base = basename(path);
  // stem = base without extension
  const stem = ext.length > 0 ? base.slice(0, base.length - ext.length) : base;
  const token = sanitizeAuthor(author);

  const candidate = (n?: number): string => {
    const suffix = n === undefined ? `(conflicto ${token})` : `(conflicto ${token} ${n})`;
    const name = `${stem} ${suffix}${ext}`;
    return dir.length > 0 ? joinPath(dir, name) : name;
  };

  let n: number | undefined;
  let c = candidate(n);
  while (existing.has(c)) {
    n = n === undefined ? 2 : n + 1;
    c = candidate(n);
  }
  return c;
}

// ─── Conflict frontmatter ─────────────────────────────────────────────────────

/** Escape a YAML double-quoted string value (only `"` and `\` need escaping). */
function yamlDoubleQuote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface ConflictMeta {
  conflictOf: string;
  conflictBase: string | null;
}

/**
 * Add or update `conflict_of` and `conflict_base` keys in a markdown document's
 * frontmatter, preserving all other keys. Creates the frontmatter block if absent.
 * Idempotent.
 *
 * - `conflict_of`: double-quoted YAML string (escaped).
 * - `conflict_base`: unquoted hash string or literal `null`.
 */
export function addConflictFrontmatter(markdown: string, meta: ConflictMeta): string {
  const { conflictOf, conflictBase } = meta;
  const { fmLines, body, hasFm } = splitFrontmatter(markdown);

  const lines0 = hasFm ? fmLines : [];
  const lines1 = upsertScalar(lines0, 'conflict_of', yamlDoubleQuote(conflictOf));
  const lines2 = upsertScalar(
    lines1,
    'conflict_base',
    conflictBase !== null ? conflictBase : 'null',
  );

  const newBody = hasFm ? body : `\n${markdown}`;
  return joinFrontmatter(lines2, newBody);
}

/**
 * Read `conflict_of` and `conflict_base` from a markdown document.
 * Returns null if there is no frontmatter or no `conflict_of` key.
 */
export function readConflictMeta(markdown: string): ConflictMeta | null {
  const { fmLines, hasFm } = splitFrontmatter(markdown);
  if (!hasFm) return null;

  const rawOf = readScalar(fmLines, 'conflict_of');
  const rawBase = readScalar(fmLines, 'conflict_base');

  if (rawOf === null) return null;

  // Unquote double-quoted value
  const conflictOf =
    rawOf.startsWith('"') && rawOf.endsWith('"')
      ? rawOf.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      : rawOf;

  const conflictBase = rawBase === null || rawBase === 'null' ? null : rawBase;

  return { conflictOf, conflictBase };
}
