/**
 * workspace/keywords.ts — shared keyword helpers used by ContextBuilder and
 * buildContextMap.  Single source of truth: no duplicate implementations.
 */

export const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'add',
  'use',
  'that',
  'this',
  'into',
  'from',
  'all',
  'can',
  'should',
  'una',
  'unos',
  'para',
  'con',
  'los',
  'las',
  'del',
]);

/**
 * Split a task string into lowercase keywords (≥ 3 chars, stopword-filtered).
 */
export function extractKeywords(task: string): string[] {
  const seen = new Set<string>();
  for (const raw of task.toLowerCase().split(/[^a-z0-9áéíóúñ]+/i)) {
    const w = raw.trim();
    if (w.length >= 3 && !STOPWORDS.has(w)) seen.add(w);
  }
  return [...seen];
}

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 */
export function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}
