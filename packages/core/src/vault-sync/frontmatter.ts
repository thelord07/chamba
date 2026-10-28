/**
 * vault-sync/frontmatter.ts — internal hand-rolled YAML frontmatter helpers.
 * Handles the minimal subset needed for conflict metadata. Pure, no deps.
 *
 * @internal — not exported from index.ts directly; use via conflict.ts.
 */

const FM_FENCE = '---';

export interface FrontmatterSplit {
  /** Raw frontmatter lines (between the two `---` fences), without fences. */
  fmLines: string[];
  /** Body text after the closing `---` (including leading newline if present). */
  body: string;
  /** True if the input had a frontmatter block. */
  hasFm: boolean;
}

/**
 * Split markdown into `{fmLines, body, hasFm}`.
 * The frontmatter block must start at line 0 with `---`.
 */
export function splitFrontmatter(markdown: string): FrontmatterSplit {
  const lines = markdown.split('\n');
  if (lines[0]?.trimEnd() !== FM_FENCE) {
    return { fmLines: [], body: markdown, hasFm: false };
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trimEnd() === FM_FENCE) {
      return {
        fmLines: lines.slice(1, i) as string[],
        body: lines.slice(i + 1).join('\n'),
        hasFm: true,
      };
    }
  }
  // Unclosed frontmatter — treat as no frontmatter
  return { fmLines: [], body: markdown, hasFm: false };
}

/**
 * Upsert a scalar key in frontmatter lines.
 * If the key exists, replaces its value line. Otherwise appends.
 * `valueRaw` is the already-formatted YAML value string (e.g. `'"my path"'` or `'null'`).
 */
export function upsertScalar(fmLines: string[], key: string, valueRaw: string): string[] {
  const prefix = `${key}:`;
  const idx = fmLines.findIndex((l) => l.startsWith(prefix));
  const newLine = `${key}: ${valueRaw}`;
  if (idx === -1) {
    return [...fmLines, newLine];
  }
  return fmLines.map((l, i) => (i === idx ? newLine : l));
}

/**
 * Read a scalar value from frontmatter lines for a given key.
 * Returns the raw string after `key: `, or null if not found.
 */
export function readScalar(fmLines: string[], key: string): string | null {
  const prefix = `${key}: `;
  for (const line of fmLines) {
    if (line.startsWith(prefix)) {
      return line.slice(prefix.length).trimEnd();
    }
  }
  return null;
}

/**
 * Reassemble frontmatter lines + body into a markdown string.
 * Always joins with LF: a CRLF document comes back with LF line endings.
 */
export function joinFrontmatter(fmLines: string[], body: string): string {
  return [FM_FENCE, ...fmLines, FM_FENCE, body].join('\n');
}
