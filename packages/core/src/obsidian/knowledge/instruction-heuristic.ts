/**
 * obsidian/knowledge/instruction-heuristic.ts — warn-only heuristic for
 * instruction-like text in notes/memories (CHAMBA-021 S5).
 *
 * Pure: no Node imports, no LLM. This NEVER blocks a write — it only flags
 * `flag: revisar` + `estado: propuesto` so a human reviews before promoting.
 * The cost of a false positive is near zero, so ambiguous cases (e.g. a note
 * that *documents* the risk by quoting the phrase) still match — see tests.
 */

export interface InstructionLikeResult {
  /** Pattern names that matched, in the order checked. */
  matched: string[];
}

interface Pattern {
  name: string;
  test: (normalized: string) => boolean;
}

/** NFD-strip accents + lowercase, same technique as `slugify`. */
function normalize(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const PATTERNS: Pattern[] = [
  {
    name: 'ignore-previous-instructions',
    test: (t) => t.includes('ignore previous instructions'),
  },
  {
    name: 'ignora-las-instrucciones',
    test: (t) => t.includes('ignora las instrucciones'),
  },
  {
    name: 'system-prompt',
    test: (t) => t.includes('system prompt'),
  },
  {
    name: 'ejecuta-el-siguiente-comando',
    test: (t) => t.includes('ejecuta el siguiente comando'),
  },
  {
    name: 'curl-pipe-shell',
    // Bounded, single pass — no nested quantifiers (hot-path discipline).
    test: (t) => /curl[^\n]{0,4096}\|\s{0,16}(sh|bash)\b/.test(t),
  },
];

/**
 * Detect instruction-like text aimed at agents (prompt-injection shape).
 * Returns the list of matched pattern names — never the original text.
 */
export function detectInstructionLike(text: string): InstructionLikeResult {
  const normalized = normalize(text);
  const matched = PATTERNS.filter((p) => p.test(normalized)).map((p) => p.name);
  return { matched };
}

/**
 * Merge several `detectInstructionLike` results (e.g. one per field —
 * title/summary/content) into one, deduping matched pattern names while
 * keeping their first-seen order. CHAMBA-021 review: a write tool must check
 * EVERY free-text field it persists, not only `content` — an injection can
 * just as easily be smuggled in via the title or the one-line summary.
 */
export function mergeInstructionLike(...results: InstructionLikeResult[]): InstructionLikeResult {
  const seen = new Set<string>();
  const matched: string[] = [];
  for (const r of results) {
    for (const name of r.matched) {
      if (!seen.has(name)) {
        seen.add(name);
        matched.push(name);
      }
    }
  }
  return { matched };
}
