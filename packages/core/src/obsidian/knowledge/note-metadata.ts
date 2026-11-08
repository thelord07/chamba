/**
 * obsidian/knowledge/note-metadata.ts — tolerant reader and surgical writer
 * for Obsidian note frontmatter following the CHAMBA-016 contract.
 * Pure TypeScript: no `node:` imports, no external dependencies.
 *
 * Canonical format decisions (documented here, tested in note-metadata.test.ts):
 *   Block lists  (  - x, 2-space indent): tags, related
 *   Inline lists ([x, y, z]):             keywords, aliases, temas_propuestos
 *   Scalars:                              title, date, type, summary, work_item,
 *                                         project, source, generated
 *
 * Quoting rule: double quotes when the value is empty, contains `:` `#` `"` `[` `]`
 * `{` `}`, has leading/trailing whitespace, or resembles bool/null/number.
 * Inline list items also get quoted when containing `,` or `'`.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export type NoteType =
  | 'plan'
  | 'resumen'
  | 'investigacion'
  | 'informe'
  | 'decision'
  | 'guia'
  | 'nota';

const VALID_NOTE_TYPES: ReadonlySet<string> = new Set<NoteType>([
  'plan',
  'resumen',
  'investigacion',
  'informe',
  'decision',
  'guia',
  'nota',
]);

export interface NoteMetadata {
  title: string;
  date?: string;
  type: NoteType;
  summary?: string;
  /** All tags from frontmatter `tags:` property. */
  tags: string[];
  /** Tags starting with `tema/`, prefix stripped, ordered, deduped. */
  temas: string[];
  /** 0–10 keywords; each ≤ 40 chars (excess truncated or ignored). */
  keywords: string[];
  aliases: string[];
  work_item?: string;
  project?: string;
  related: string[];
  temas_propuestos: string[];
  source?: string;
  generated?: boolean;

  // ── CHAMBA-021: provenance + governance contract ────────────────────────────
  /** Human name of the person behind the write (never an email). */
  author?: string;
  /** `chamba/<tool>@<version>` — which chamba tool/version wrote or last touched this note. */
  agent?: string;
  /** ISO timestamp of the (last agent) write. */
  written_at?: string;
  /** `propuesto` | `canonico`. Absent ⇒ canónico (D-Q3). Any other value reads as `undefined`. */
  estado?: 'propuesto' | 'canonico';
  /** Free-form flag, e.g. `revisar` (instruction-like content detected). */
  flag?: string;
  /** D-Q4: name of whoever ran `classify apply` on a human note (add-only). */
  clasificado_por?: string;
}

// ─── Internal constants ───────────────────────────────────────────────────────

/** Fixed order for new keys appended to frontmatter. */
const KEY_ORDER: ReadonlyArray<keyof NoteMetadata> = [
  'title',
  'date',
  'type',
  'summary',
  'tags',
  'keywords',
  'aliases',
  'work_item',
  'project',
  'related',
  'temas_propuestos',
  'source',
  'generated',
  // CHAMBA-021: appended at the end to minimize churn on existing notes.
  'author',
  'agent',
  'written_at',
  'estado',
  'flag',
  'clasificado_por',
];

/** Keys rendered as block lists (`  - x` per line). */
const BLOCK_LIST_KEYS: ReadonlySet<string> = new Set(['tags', 'related']);

/** Keys rendered as inline lists (`[x, y]`). */
const INLINE_LIST_KEYS: ReadonlySet<string> = new Set(['keywords', 'aliases', 'temas_propuestos']);

/** Keys that are plain scalars (not lists). */
const SCALAR_KEYS: ReadonlySet<string> = new Set([
  'title',
  'date',
  'type',
  'summary',
  'work_item',
  'project',
  'source',
  'generated',
  'author',
  'agent',
  'written_at',
  'estado',
  'flag',
  'clasificado_por',
]);

// ─── NFC normalization ────────────────────────────────────────────────────────

/** Normalize a string to NFC (M6). */
function nfc(s: string): string {
  return s.normalize('NFC');
}

/** Normalize an array of strings to NFC. */
function nfcArr(arr: string[]): string[] {
  return arr.map(nfc);
}

// ─── EOL helpers ─────────────────────────────────────────────────────────────

/**
 * Detect dominant end-of-line in the content.
 * Returns `'\r'` (the suffix to add before `\n` when joining) if CRLF
 * is dominant, otherwise `''` for LF.
 */
function detectLineEnd(content: string): string {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') {
      if (i > 0 && content[i - 1] === '\r') crlf++;
      else lf++;
    }
  }
  return crlf > lf ? '\r' : '';
}

/** Strip a trailing `\r` from a line (if present). */
function stripCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

// ─── Frontmatter splitting ────────────────────────────────────────────────────

interface FmSplit {
  /** Zero-based index of the opening `---` line in allLines. Always 0 if hasFm. */
  openIdx: number;
  /** Zero-based index of the closing `---` line in allLines. */
  closeIdx: number;
  /** All lines of the document (split on `\n`). */
  allLines: string[];
  hasFm: boolean;
}

function splitDoc(content: string): FmSplit {
  const allLines = content.split('\n');
  if (stripCR(allLines[0] ?? '') !== '---') {
    return { openIdx: 0, closeIdx: -1, allLines, hasFm: false };
  }
  for (let i = 1; i < allLines.length; i++) {
    if (stripCR(allLines[i] ?? '') === '---') {
      return { openIdx: 0, closeIdx: i, allLines, hasFm: true };
    }
  }
  // Unclosed frontmatter → treat as no frontmatter
  return { openIdx: 0, closeIdx: -1, allLines, hasFm: false };
}

// ─── YAML scalar / list parsing ───────────────────────────────────────────────

/** Parse a YAML double-quoted string value (the surrounding `"` must be present). */
function parseDoubleQuoted(v: string): string {
  // Find the closing `"` respecting `\` escapes
  let result = '';
  let i = 1; // skip opening `"`
  while (i < v.length) {
    const ch = v[i];
    if (ch === '\\') {
      const next = v[i + 1] ?? '';
      switch (next) {
        case 'n':
          result += '\n';
          break;
        case 't':
          result += '\t';
          break;
        case '"':
          result += '"';
          break;
        case '\\':
          result += '\\';
          break;
        default:
          result += next;
          break;
      }
      i += 2;
    } else if (ch === '"') {
      break;
    } else {
      result += ch;
      i++;
    }
  }
  return result;
}

/** Parse a YAML single-quoted string value (surrounding `'` must be present). */
function parseSingleQuoted(v: string): string {
  // Only `''` is an escape (for a literal single quote)
  const inner = v.slice(1, v.length - 1);
  return inner.replace(/''/g, "'");
}

/** Parse a YAML scalar (unquoted, double-quoted, or single-quoted). Returns string. */
function parseYamlScalar(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"')) return parseDoubleQuoted(v);
  if (v.startsWith("'")) return parseSingleQuoted(v);
  return v;
}

/**
 * Strip a trailing `# comment` from a YAML value string.
 * Respects double- and single-quoted regions; `#` preceded by whitespace is a comment.
 */
function stripComment(s: string): string {
  let inDouble = false;
  let inSingle = false;
  let prevSpace = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      prevSpace = false;
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      prevSpace = false;
    } else if (ch === '#' && !inDouble && !inSingle && prevSpace) {
      return s.slice(0, i).trimEnd();
    } else {
      prevSpace = ch === ' ' || ch === '\t';
    }
  }
  return s;
}

/** Parse an inline YAML list `[item1, "item two", ...]` into string items. */
function parseInlineList(raw: string): string[] {
  const s = raw.trim();
  if (!s.startsWith('[') || !s.endsWith(']')) return [];
  const inner = s.slice(1, -1);
  if (inner.trim() === '') return [];

  const items: string[] = [];
  let current = '';
  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    // M5: handle backslash escapes inside double-quoted strings
    if (inDouble && ch === '\\') {
      // Escape sequence — accumulate verbatim so parseDoubleQuoted can handle it
      current += ch;
      if (i + 1 < inner.length) {
        current += inner[i + 1];
        i++;
      }
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === ',' && !inDouble && !inSingle) {
      const parsed = parseYamlScalar(current.trim());
      if (parsed !== '') items.push(parsed);
      current = '';
    } else {
      current += ch;
    }
  }
  const last = parseYamlScalar(current.trim());
  if (last !== '') items.push(last);
  return items;
}

/**
 * Parse frontmatter lines (the raw lines between the `---` fences, may have trailing `\r`)
 * into a string-keyed map.
 *
 * Returns a best-effort map. Unknown structure is silently ignored.
 */
function parseFmLines(fmLines: string[]): Map<string, unknown> {
  const result = new Map<string, unknown>();
  let i = 0;

  while (i < fmLines.length) {
    const rawLine = fmLines[i] ?? '';
    const line = stripCR(rawLine);
    i++;

    // Skip blank lines and comment-only lines
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;

    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;

    const key = line.slice(0, colonIdx).trimEnd();
    // Keys must be at column 0 (not indented) for top-level frontmatter
    if (line[0] === ' ' || line[0] === '\t') continue;

    const afterColon = line.slice(colonIdx + 1);
    const afterColonTrimmed = afterColon.trimStart();

    // Distinguish between: block list, inline list, scalar
    if (afterColonTrimmed === '' || afterColonTrimmed.startsWith('#')) {
      // Potentially a block list; look ahead for `  - ` lines
      const items: string[] = [];
      while (i < fmLines.length) {
        const nextLine = stripCR(fmLines[i] ?? '');
        const m = nextLine.match(/^(\s+)- (.*)/);
        if (m) {
          items.push(parseYamlScalar((m[2] ?? '').trim()));
          i++;
        } else {
          break;
        }
      }
      result.set(key, items.length > 0 ? items : null);
    } else if (afterColonTrimmed.startsWith('[')) {
      result.set(key, parseInlineList(afterColonTrimmed));
    } else {
      // Scalar: strip comment, parse
      const stripped = stripComment(afterColonTrimmed).trimEnd();
      const isQuoted =
        (stripped.startsWith('"') && stripped.endsWith('"')) ||
        (stripped.startsWith("'") && stripped.endsWith("'"));
      const parsed = parseYamlScalar(stripped);
      // Detect booleans/null only for UNQUOTED values (quoted `"true"` is a string)
      if (!isQuoted && (parsed === 'true' || parsed === 'yes')) result.set(key, true);
      else if (!isQuoted && (parsed === 'false' || parsed === 'no')) result.set(key, false);
      else if (!isQuoted && (parsed === 'null' || parsed === '~')) result.set(key, null);
      else result.set(key, parsed);
    }
  }

  return result;
}

// ─── Helper coercions ─────────────────────────────────────────────────────────

function asString(v: unknown): string | undefined {
  if (v === null || v === undefined || v === false) return undefined;
  if (typeof v === 'boolean') return String(v);
  const s = String(v);
  // Don't trim the string value — quoted YAML values preserve leading/trailing spaces
  // intentionally. Callers that need trimming do it themselves.
  return s === '' ? undefined : s;
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter((s) => s.trim() !== '');
  if (typeof v === 'string' && v.trim() !== '') return [v.trim()];
  return [];
}

function extractTemas(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    if (tag.startsWith('tema/')) {
      const tema = tag.slice('tema/'.length);
      if (tema && !seen.has(tema)) {
        seen.add(tema);
        result.push(tema);
      }
    }
  }
  return result;
}

/** Extract the first non-heading paragraph from the note body, ≤ 200 chars. */
function firstParagraph(body: string): string | undefined {
  const lines = body.split('\n');
  const paragraphLines: string[] = [];
  let inParagraph = false;

  for (const rawLine of lines) {
    const line = stripCR(rawLine).trimEnd();
    if (line.startsWith('#')) {
      if (inParagraph) break;
      continue;
    }
    if (line === '') {
      if (inParagraph) break;
      continue;
    }
    inParagraph = true;
    paragraphLines.push(line);
  }

  if (paragraphLines.length === 0) return undefined;
  const joined = paragraphLines.join(' ');
  return joined.length > 200 ? joined.slice(0, 200) : joined;
}

// ─── Public: readNoteMetadata ─────────────────────────────────────────────────

/**
 * Read note metadata from Obsidian markdown `content`.
 * `path` is used to derive the default title (basename without `.md`).
 *
 * Tolerant: frontmatter absent / partial / YAML-invalid → returns a valid
 * NoteMetadata with sensible defaults; never throws.
 */
export function readNoteMetadata(content: string, path: string): NoteMetadata {
  const defaultTitle = (() => {
    const segments = path.replace(/\\/g, '/').split('/');
    const base = segments[segments.length - 1] ?? path;
    return base.endsWith('.md') ? base.slice(0, -3) : base;
  })();

  const { allLines, hasFm, openIdx, closeIdx } = splitDoc(content);

  const fmLines = hasFm ? allLines.slice(openIdx + 1, closeIdx) : [];
  const bodyLines = hasFm ? allLines.slice(closeIdx + 1) : allLines;
  const body = bodyLines.join('\n');

  let fm: Map<string, unknown>;
  try {
    fm = parseFmLines(fmLines);
  } catch {
    fm = new Map();
  }

  const title = nfc(asString(fm.get('title')) ?? defaultTitle);
  const date = asString(fm.get('date'));
  const rawType = asString(fm.get('type'));
  const type: NoteType =
    rawType !== undefined && VALID_NOTE_TYPES.has(rawType) ? (rawType as NoteType) : 'nota';

  const rawSummary = asString(fm.get('summary'));
  const summary =
    rawSummary !== undefined
      ? // M6: NFC-normalize the summary
        (() => {
          const s = nfc(rawSummary);
          return s.length > 200 ? s.slice(0, 200) : s;
        })()
      : firstParagraph(body);

  const tags = nfcArr(asStringArray(fm.get('tags')));
  const temas = extractTemas(tags);

  const rawKeywords = nfcArr(asStringArray(fm.get('keywords')));
  // M10: truncate by code points (not UTF-16 code units) so emoji count as 1
  const keywords = rawKeywords.slice(0, 10).map((k) => {
    const codePoints = [...k];
    return codePoints.length > 40 ? codePoints.slice(0, 40).join('') : k;
  });

  const aliases = nfcArr(asStringArray(fm.get('aliases')));
  const work_item = asString(fm.get('work_item'));
  const project = asString(fm.get('project'));
  const related = nfcArr(asStringArray(fm.get('related')));
  const temas_propuestos = nfcArr(asStringArray(fm.get('temas_propuestos')));
  const source = asString(fm.get('source'));

  const generatedRaw = fm.get('generated');
  const generated =
    generatedRaw === true
      ? true
      : generatedRaw === false
        ? false
        : generatedRaw === 'true'
          ? true
          : generatedRaw === 'false'
            ? false
            : undefined;

  const author = asString(fm.get('author'));
  const agent = asString(fm.get('agent'));
  const written_at = asString(fm.get('written_at'));
  const rawEstado = asString(fm.get('estado'));
  const estado: NoteMetadata['estado'] =
    rawEstado === 'propuesto' || rawEstado === 'canonico' ? rawEstado : undefined;
  const flag = asString(fm.get('flag'));
  const clasificado_por = asString(fm.get('clasificado_por'));

  return {
    title,
    ...(date !== undefined && { date }),
    type,
    ...(summary !== undefined && { summary }),
    tags,
    temas,
    keywords,
    aliases,
    ...(work_item !== undefined && { work_item }),
    ...(project !== undefined && { project }),
    related,
    temas_propuestos,
    ...(source !== undefined && { source }),
    ...(generated !== undefined && { generated }),
    ...(author !== undefined && { author: nfc(author) }),
    ...(agent !== undefined && { agent }),
    ...(written_at !== undefined && { written_at }),
    ...(estado !== undefined && { estado }),
    ...(flag !== undefined && { flag }),
    ...(clasificado_por !== undefined && { clasificado_por: nfc(clasificado_por) }),
  };
}

/**
 * CHAMBA-021 S10: single source of truth for "is this note canonical".
 * D-Q3 (owner decision): `estado` absent ⇒ canónico, for ANY note (human or chamba).
 * Every consumer (ranking, hubs, counts, doctor) must go through this helper —
 * never compare `meta.estado` directly.
 */
export function esCanonico(meta: Pick<NoteMetadata, 'estado'>): boolean {
  return meta.estado !== 'propuesto';
}

// ─── Quoting helpers ──────────────────────────────────────────────────────────

/** Characters that force quoting in a YAML scalar value. */
const FORCE_QUOTE_CHARS = /[:#{}[\]"']/;
/** Values that resemble YAML special forms (booleans, null, numbers). */
const SPECIAL_FORMS = /^(true|false|yes|no|null|~|-?[0-9].*)$/i;

function needsScalarQuoting(v: string): boolean {
  if (v === '') return true;
  // ISO dates stay unquoted so Obsidian types the property as a date (read back as a string).
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  if (SPECIAL_FORMS.test(v)) return true;
  if (FORCE_QUOTE_CHARS.test(v)) return true;
  if (v !== v.trim()) return true; // leading/trailing whitespace
  return false;
}

/**
 * Quote a scalar value with double quotes if needed.
 * Escapes `\` and `"` inside the quoted string.
 */
export function quoteScalar(v: string): string {
  if (!needsScalarQuoting(v)) return v;
  const escaped = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function needsInlineQuoting(v: string): boolean {
  return needsScalarQuoting(v) || v.includes(',') || v.includes("'");
}

function quoteInline(v: string): string {
  if (!needsInlineQuoting(v)) return v;
  const escaped = v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

// ─── Key-value rendering ──────────────────────────────────────────────────────

/**
 * Render a frontmatter key-value pair as an array of raw lines.
 * Each line does NOT include a trailing `\n`; the caller joins with `\n`.
 * `lineEnd` is `'\r'` for CRLF files, `''` for LF files.
 */
function renderKeyValue(key: string, value: unknown, lineEnd: string): string[] {
  if (BLOCK_LIST_KEYS.has(key)) {
    const items = asStringArray(value);
    if (items.length === 0) {
      return [`${key}:${lineEnd}`];
    }
    return [`${key}:${lineEnd}`, ...items.map((item) => `  - ${quoteScalar(item)}${lineEnd}`)];
  }

  if (INLINE_LIST_KEYS.has(key)) {
    const items = asStringArray(value);
    const rendered = items.map((item) => quoteInline(item)).join(', ');
    return [`${key}: [${rendered}]${lineEnd}`];
  }

  if (SCALAR_KEYS.has(key)) {
    if (typeof value === 'boolean') {
      return [`${key}: ${value}${lineEnd}`];
    }
    const str = value === null || value === undefined ? '' : String(value);
    return [`${key}: ${quoteScalar(str)}${lineEnd}`];
  }

  // Unknown key — render as scalar (best effort)
  const str = value === null || value === undefined ? '' : String(value);
  return [`${key}: ${quoteScalar(str)}${lineEnd}`];
}

// ─── Key range detection ──────────────────────────────────────────────────────

interface KeyRange {
  /** Start line index in the fmLines array (inclusive). */
  start: number;
  /** End line index (exclusive). Includes block list entries. */
  end: number;
}

/**
 * Find the range of lines occupied by `key` in the given frontmatter lines array.
 * Lines may have trailing `\r`. Returns null if the key is not found.
 */
function findKeyRange(fmLines: string[], key: string): KeyRange | null {
  const prefix = `${key}:`;

  for (let i = 0; i < fmLines.length; i++) {
    const line = stripCR(fmLines[i] ?? '');

    // Must start at column 0 (top-level key)
    if (line[0] === ' ' || line[0] === '\t') continue;
    if (!line.startsWith(prefix)) continue;

    // Confirm the char after the colon is whitespace, end-of-line, or `#`
    const afterColon = line.slice(prefix.length);
    if (
      afterColon !== '' &&
      afterColon[0] !== ' ' &&
      afterColon[0] !== '\t' &&
      afterColon[0] !== '#'
    ) {
      // e.g., `tags_extra:` would have `_extra:` after `tags:` — not a match
      // Actually this case can't happen because `tags_extra:` doesn't start with `tags:`
      // But we keep this guard for safety
      continue;
    }

    let end = i + 1;
    const valuePart = stripComment(afterColon.trimStart()).trim();
    if (valuePart === '') {
      // Potential block list: consume following indented `- ` lines
      while (end < fmLines.length) {
        const nextLine = stripCR(fmLines[end] ?? '');
        if (/^\s+- /.test(nextLine)) {
          end++;
        } else {
          break;
        }
      }
    }

    return { start: i, end };
  }

  return null;
}

// ─── Public: upsertNoteMetadata ───────────────────────────────────────────────

/**
 * Surgical frontmatter writer.
 *
 * Modifies **only** the keys present in `patch`, leaving all other frontmatter
 * lines (including unknown keys, comments, and their order) byte-for-byte intact.
 * The note body is never touched.
 *
 * - Keys present in existing frontmatter → replaced in-place (canonical format).
 * - Keys absent from existing frontmatter → appended at the end in `KEY_ORDER`.
 * - `temas` is a derived field and is silently skipped (modify `tags` instead).
 * - If there is no frontmatter, a new block is prepended.
 * - EOL of new/modified lines matches the document's dominant EOL (CRLF or LF).
 */
export function upsertNoteMetadata(content: string, patch: Partial<NoteMetadata>): string {
  // M6: normalize scalar and list patch values to NFC before rendering
  const normPatch: Partial<NoteMetadata> = { ...patch };
  for (const key of Object.keys(normPatch) as Array<keyof NoteMetadata>) {
    const val = normPatch[key];
    if (typeof val === 'string') {
      // biome-ignore lint/suspicious/noExplicitAny: narrow key-value pair
      (normPatch as any)[key] = nfc(val);
    } else if (Array.isArray(val)) {
      // biome-ignore lint/suspicious/noExplicitAny: narrow key-value pair
      (normPatch as any)[key] = (val as unknown[]).map((item) =>
        typeof item === 'string' ? nfc(item) : item,
      );
    }
  }

  const lineEnd = detectLineEnd(content);
  const { allLines, hasFm, closeIdx } = splitDoc(content);

  if (!hasFm) {
    // No existing frontmatter — create one and prepend
    const newFm = renderNewFrontmatter(normPatch, lineEnd);
    return [...newFm, ...allLines].join('\n');
  }

  // fmLines: allLines[1 .. closeIdx-1]
  let fmLines = allLines.slice(1, closeIdx);

  const keysToAppend: (keyof NoteMetadata)[] = [];

  // Process patch keys in KEY_ORDER to guarantee stable output order
  for (const key of KEY_ORDER) {
    // Skip derived `temas` — not a real frontmatter key
    if (key === 'temas') continue;

    const value = normPatch[key];
    if (value === undefined) continue;

    const range = findKeyRange(fmLines, key);
    if (range !== null) {
      const newLines = renderKeyValue(key, value, lineEnd);
      fmLines = [...fmLines.slice(0, range.start), ...newLines, ...fmLines.slice(range.end)];
    } else {
      keysToAppend.push(key);
    }
  }

  // Append new keys (those not found in existing frontmatter) in fixed KEY_ORDER
  for (const key of KEY_ORDER) {
    if (key === 'temas') continue;
    if (!keysToAppend.includes(key)) continue;
    const value = normPatch[key];
    if (value !== undefined) {
      fmLines.push(...renderKeyValue(key, value, lineEnd));
    }
  }

  // Reconstruct: open fence + modified fm lines + close fence + body
  const openFence = allLines[0] ?? `---${lineEnd}`;
  const closeFence = allLines[closeIdx] ?? `---${lineEnd}`;
  const bodyLines = allLines.slice(closeIdx + 1);

  return [openFence, ...fmLines, closeFence, ...bodyLines].join('\n');
}

/** Render a complete new frontmatter block (lines without `\n`, each ending with `lineEnd`). */
function renderNewFrontmatter(patch: Partial<NoteMetadata>, lineEnd: string): string[] {
  const lines: string[] = [`---${lineEnd}`];
  for (const key of KEY_ORDER) {
    if (key === 'temas') continue;
    const value = patch[key];
    if (value !== undefined) {
      lines.push(...renderKeyValue(key, value, lineEnd));
    }
  }
  lines.push(`---${lineEnd}`);
  return lines;
}
