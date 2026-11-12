/**
 * secrets/entropy.ts — Shannon entropy + placeholder detection for the
 * `assignment` secret rule (CHAMBA-021 S1).
 *
 * Pure: no Node imports, no IO.
 */

/** Shannon entropy (bits per character) of `s`. Returns 0 for an empty string. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Canonical placeholder string chamba asks users to paste in place of a real
 * secret (used in the write-time rejection message, D-Q1). Kept here so
 * `isPlaceholder` and the message helpers agree on the exact literal.
 */
export const REDACTED_PLACEHOLDER = '<REDACTADO>';

const PLACEHOLDER_WORDS = new Set([
  'changeme',
  'change-me',
  'your-key-here',
  'yourkeyhere',
  'your_key_here',
]);

// Bounded, non-backtracking patterns only (hot-path S1).
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /^<[^>]{1,128}>$/, // <REDACTED>, <tu-token>, <REDACTADO>
  /^x{4,128}$/i, // xxxx…
  /^\*{3,128}$/, // ***
  /^\$\{[^}]{1,128}\}$/, // ${VAR}
  /^process\.env\.[A-Za-z0-9_]{1,128}$/, // process.env.OPENAI_API_KEY
];

/**
 * Returns true when `value` looks like a placeholder rather than a real secret.
 * Used only by the `assignment` rule (prefix-form secrets like `AKIA…` are
 * never placeholders — they match by shape, not by entropy).
 */
export function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return true;
  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_WORDS.has(lower)) return true;
  for (const re of PLACEHOLDER_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  return false;
}

// Only lowercase letters joined by hyphens, ≥2 "words" — e.g.
// "no-expiration-by-default". A real secret practically always mixes case,
// digits, or other non-word characters; this shape is hyphenated prose.
const PROSE_WORDS_RE = /^[a-z]+(?:-[a-z]+)+$/;

/**
 * True when `value` looks like hyphenated lowercase prose rather than a
 * secret. Used only by the `assignment` rule's entropy filter: Shannon
 * entropy alone can't tell "no-expiration-by-default" from a real token —
 * both have many distinct characters — so this shape-based check rejects it
 * even when its entropy clears `MIN_ENTROPY`.
 */
export function looksLikeProseWords(value: string): boolean {
  return PROSE_WORDS_RE.test(value.trim());
}
