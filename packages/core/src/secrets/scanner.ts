/**
 * secrets/scanner.ts — public, value-free secret scanner (CHAMBA-021 S2).
 *
 * `scanText` is the ONLY public entry point into the secrets module: it never
 * returns the raw matched value, only a 12-hex `fingerprint` derived from it.
 * Pure: no Node imports; hashing goes through `HashPort`.
 */

import type { HashPort } from '../ports/hash.js';
import { extname } from '../util/path.js';
import type { SecretKind } from './rules.js';
import { matchRules } from './rules.js';

export type { SecretKind };

export interface Finding {
  path: string;
  /** 1-based line number. */
  line: number;
  kind: SecretKind;
  /** sha256(`${kind}\n${value}`), first 12 hex chars. Never the value itself. */
  fingerprint: string;
}

// `.svg` is syncable plaintext (XML/CSS-ish text, not a raster/binary image
// format), so it's scanned like the other text notes — unlike `.png`/`.pdf`.
const SCANNABLE_EXTENSIONS = new Set(['.md', '.canvas', '.base', '.svg']);

/** True when `path`'s extension is one the secret scanner covers (CHAMBA-021 §2.1: images/PDF out of scope). */
export function isScannable(path: string): boolean {
  return SCANNABLE_EXTENSIONS.has(extname(path).toLowerCase());
}

async function fingerprintOf(hash: HashPort, kind: SecretKind, value: string): Promise<string> {
  const data = new TextEncoder().encode(`${kind}\n${value}`);
  const full = await hash.sha256(data);
  return full.slice(0, 12);
}

/**
 * Scan `text` (the contents of `path`) for secret-shaped values.
 * Returns `Finding[]` — deduplicated by `(line, kind, fingerprint)`, sorted by
 * line ascending then kind ascending. The matched value never appears in the
 * result; only its fingerprint does.
 */
export async function scanText(
  deps: { hash: HashPort },
  text: string,
  path: string,
): Promise<Finding[]> {
  const raw = matchRules(text);
  const seen = new Set<string>();
  const findings: Finding[] = [];

  for (const m of raw) {
    const fingerprint = await fingerprintOf(deps.hash, m.kind, m.value);
    const key = `${m.line}\u0000${m.kind}\u0000${fingerprint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({ path, line: m.line, kind: m.kind, fingerprint });
  }

  findings.sort((a, b) => a.line - b.line || a.kind.localeCompare(b.kind));
  return findings;
}

/** One write-time field to scan, e.g. `{ field: 'title', value: title }`. */
export interface WriteField {
  /** Field name, used only for reporting (e.g. "title", "content", "tags"). */
  field: string;
  value: string | string[] | undefined;
}

/**
 * A write-time finding — same shape as `Finding`, but `field` names which
 * input field it came from (`title`, `content`, …) instead of a vault path
 * (no file exists yet at write time).
 */
export interface WriteFieldFinding {
  field: string;
  /** 1-based line number WITHIN that field's own text (never offset by other fields). */
  line: number;
  kind: SecretKind;
  fingerprint: string;
}

/**
 * D-Q1 (CHAMBA-021 §9, owner decision): scan every field a write-time tool is
 * about to persist (title/summary/keywords/tags/content, etc.) BEFORE writing
 * anything.
 *
 * Each field is scanned SEPARATELY (not joined with the others) so a line
 * number always refers to a position within that field's own text — joining
 * fields would silently offset line numbers for every field after the first.
 * A field that is itself an array (e.g. `tags`) is joined with newlines
 * before scanning, since its entries share one field name.
 */
export async function scanWriteFields(
  deps: { hash: HashPort },
  fields: WriteField[],
): Promise<WriteFieldFinding[]> {
  const findings: WriteFieldFinding[] = [];
  for (const { field, value } of fields) {
    if (value === undefined) continue;
    const text = Array.isArray(value) ? value.join('\n') : value;
    if (text.length === 0) continue;
    const perField = await scanText(deps, text, field);
    for (const f of perField) {
      findings.push({ field: f.path, line: f.line, kind: f.kind, fingerprint: f.fingerprint });
    }
  }
  return findings;
}
