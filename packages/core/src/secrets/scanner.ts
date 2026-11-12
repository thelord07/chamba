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

/**
 * True when `path`'s extension is one of the 4 extensions originally covered
 * by the scanner (CHAMBA-021 §2.1). CHAMBA-023 D-Q3 (owner decision) replaces
 * this extension-based gate with the content-based `shouldScanContent` for
 * `screenPushEntries` (secret-gate.ts) and `buildAdoptionSummary`
 * (adoption.ts) — `.pdf`/`.png`/etc. can also be scanned when their bytes
 * happen to decode as UTF-8 text. Kept exported for backward compatibility
 * with any other caller that still wants the narrower, extension-only check.
 */
export function isScannable(path: string): boolean {
  return SCANNABLE_EXTENSIONS.has(extname(path).toLowerCase());
}

/**
 * CHAMBA-023 D-Q3 (owner decision, §9): the server scans ANY blob that
 * decodes as strict UTF-8 and is ≤ `MAX_SCAN_BYTES`, regardless of
 * extension — not just `.md`/`.canvas`/`.base`/`.svg`. A `.pdf` or similar
 * binary-by-extension file that happens to be valid UTF-8 text can still be
 * rejected by the server with no local finding and no fingerprint to
 * allowlist (CHAMBA-023 plan §1 Open question 5). `shouldScanContent` is the
 * single source of truth for "should the client scan these bytes, and with
 * what text", shared by the push gate and the adoption summary, so client
 * and server agree on what gets scanned.
 *
 * Strict UTF-8 (`TextDecoder` with `fatal: true`) — NOT a Node API, pure
 * Web-standard global available in both the browser and Node runtimes.
 */
export const MAX_SCAN_BYTES = 2 * 1024 * 1024;

const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });
// Lossy (non-fatal) decoder — invalid byte sequences become U+FFFD instead
// of failing. Used ONLY for the original 4 `isScannable` extensions, to
// preserve exact 1.15.0 behavior (see review B1 below).
const lossyUtf8Decoder = new TextDecoder('utf-8');

/**
 * Decide whether `bytes` should be scanned for secrets, and return the
 * decoded text to scan — or `null` if it shouldn't be scanned at all. Never
 * decodes twice: callers scan the returned string directly instead of
 * re-decoding `bytes` themselves (review non-blocking item 11).
 *
 * CHAMBA-023 review B1 (fail-open fix): content-based scanning (D-Q3) must
 * not REGRESS what 1.15.0 already covered for the 4 originally-scannable
 * extensions (`.md`/`.canvas`/`.base`/`.svg`, `isScannable`). 1.15.0 used a
 * lossy decode (`TextDecoder` without `fatal`) and no size cap for those —
 * so a `.md` in ISO-8859-1 (invalid UTF-8) or over 2 MB with a secret in it
 * WAS caught before CHAMBA-023. A strict-UTF-8-only, size-capped check for
 * *every* syncable file would silently stop scanning those cases — a new,
 * real fail-open. So the gate is split by path:
 *
 *  - `path` is one of the 4 `isScannable` extensions → preserve 1.15.0
 *    behavior exactly: lossy decode, unconditionally, no size cap. Always
 *    returns a string (every byte sequence decodes lossily to *something*).
 *  - Any other syncable file (`.pdf`, `.png`, …, or `path` omitted) → the
 *    D-Q3 content-based gate: strict UTF-8 AND ≤ `MAX_SCAN_BYTES`, so a
 *    genuinely binary file (which would never pass strict decoding anyway)
 *    is never scanned, and a huge-but-valid-UTF-8 file doesn't get scanned
 *    either (bounded cost — these extensions were never scanned pre-D-Q3 at
 *    all, so there's no existing behavior to preserve here).
 *
 * Server note (PARCHE): `PUT /api/blob/:hash` carries no path, so a server
 * calling this without `path` gets the strict branch — a `.md` that is not
 * valid UTF-8 or exceeds `MAX_SCAN_BYTES` is then covered only by the
 * client-side gate. Pass `path` whenever it is known.
 */
export function shouldScanContent(bytes: Uint8Array, path?: string): string | null {
  if (path !== undefined && isScannable(path)) {
    return lossyUtf8Decoder.decode(bytes);
  }
  if (bytes.byteLength > MAX_SCAN_BYTES) return null;
  try {
    return strictUtf8Decoder.decode(bytes);
  } catch {
    return null;
  }
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
