/**
 * secrets/rules.ts — deterministic secret-pattern table (CHAMBA-021 S1).
 *
 * Pure: no Node imports, no IO, no LLM. `matchRules` is intentionally NOT
 * exported from `core/src/index.ts` (only `scanText`/`Finding` are public) —
 * the raw matched value must never leave this module except through the
 * value-stripping `scanText` wrapper in `scanner.ts`.
 *
 * hot-path (CHAMBA-021 §6): this runs over every changed `.md`/`.canvas`/`.base`
 * file on every sync and autosync. All regexes below have an explicit upper
 * bound (≤ 4096 per capturing span) and no nested quantifiers, so none can
 * backtrack catastrophically. Lines longer than the 64 KiB window are scanned
 * in overlapping windows (overlap 16 KiB ≥ the longest total match) so no match can be
 * split across a window boundary without also appearing intact in the next one.
 * The overlap is 16 KiB, ≥ the longest TOTAL match (JWT ≈ 12 291 chars).
 */

import { isPlaceholder, looksLikeProseWords, shannonEntropy } from './entropy.js';

export type SecretKind =
  | 'parche-token'
  | 'openai-key'
  | 'resend-key'
  | 'aws-access-key'
  | 'aws-temp-key'
  | 'google-api-key'
  | 'github-token'
  | 'github-pat'
  | 'slack-token'
  | 'gitlab-pat'
  | 'jwt'
  | 'private-key'
  | 'connection-string'
  | 'assignment';

export interface RuleMatch {
  kind: SecretKind;
  /** 1-based line number. */
  line: number;
  /** The detected value — NEVER leaves this module (scanner.ts strips it). */
  value: string;
}

const MIN_ENTROPY = 3.5;

// ── Per-kind rules ────────────────────────────────────────────────────────────
// Each rule has an explicit upper bound. `entropyChecked: true` means the
// matched capture group (or whole match, if no group) must pass the entropy +
// placeholder filter; all shape-prefixed rules skip that filter entirely.

interface Rule {
  kind: SecretKind;
  /** Must be a global regex (`g` flag). */
  re: RegExp;
  entropyChecked?: boolean;
  /** Extra post-filter (e.g. JWT minimum total length). */
  extra?: (value: string) => boolean;
}

const RULES: Rule[] = [
  { kind: 'parche-token', re: /pch_[A-Za-z0-9_-]{8,4096}/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,4096}\b/g },
  { kind: 'resend-key', re: /\bre_[A-Za-z0-9_-]{8,4096}\b/g },
  { kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'aws-temp-key', re: /\bASIA[0-9A-Z]{16}\b/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g },
  { kind: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g },
  { kind: 'slack-token', re: /\bxox[abp]-[A-Za-z0-9-]{10,4096}\b/g },
  { kind: 'gitlab-pat', re: /\bglpat-[A-Za-z0-9_-]{10,4096}\b/g },
  {
    kind: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}\.[A-Za-z0-9_-]{1,4096}\b/g,
    extra: (value) => value.length >= 60,
  },
  { kind: 'private-key', re: /-----BEGIN [A-Z0-9 ]{1,40}PRIVATE KEY-----/g },
  {
    kind: 'connection-string',
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]{1,256}:[^\s@/]{1,256}@[^\s/]{1,256}/g,
  },
  {
    kind: 'assignment',
    re: /(api[_-]?key|secret|password|passwd|token|client_secret)[ \t]{0,16}[:=][ \t]{0,16}['"]?([A-Za-z0-9/+_.-]{16,4096})['"]?/gi,
    entropyChecked: true,
  },
];

/** Window used to scan lines longer than this (hot-path §6: a `.canvas` is one line). */
const WINDOW_SIZE = 64 * 1024;
/**
 * Overlap ≥ the longest possible TOTAL match of any rule (not per span): the
 * JWT rule can reach 3×4096 + 2 dots ≈ 12 291 chars and `assignment` ≈ 4 150.
 * With overlap ≥ that, a match that touches a non-final window's right edge
 * always starts inside the next window, which therefore sees it intact.
 */
export const MAX_MATCH_LENGTH = 3 * 4096 + 2;
const WINDOW_OVERLAP = 16 * 1024;

function scanWindow(
  window: string,
  lineNo: number,
  out: RuleMatch[],
  isFinalWindow: boolean,
): void {
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
    while ((m = rule.re.exec(window)) !== null) {
      // Avoid infinite loops on zero-length matches (none of the rules above
      // can match empty, but this guards against future rule edits).
      if (m[0].length === 0) {
        rule.re.lastIndex++;
        continue;
      }
      const matchEnd = m.index + m[0].length;
      if (!isFinalWindow && matchEnd === window.length) {
        // The match touches this (non-final) window's right edge: the real
        // token may continue past it and got truncated here. Drop it — the
        // overlap (>= MAX_MATCH_LENGTH, the longest total match) guarantees
        // the next window starts at or before this match's start, so the FULL
        // token is captured intact there instead.
        continue;
      }
      const value = rule.kind === 'assignment' ? (m[2] ?? '') : m[0];
      if (value.length === 0) continue;
      if (rule.extra && !rule.extra(m[0])) continue;
      if (rule.entropyChecked) {
        if (isPlaceholder(value)) continue;
        // Hyphenated lowercase prose (`token: no-expiration-by-default`) is
        // skipped — except for password-like keys, where a diceware passphrase
        // (`correct-horse-battery-staple`) is indistinguishable from prose.
        const key = (m[1] ?? '').toLowerCase();
        const passwordLike = key === 'password' || key === 'passwd' || key === 'secret';
        if (!passwordLike && looksLikeProseWords(value)) continue;
        if (shannonEntropy(value) < MIN_ENTROPY) continue;
      }
      out.push({ kind: rule.kind, line: lineNo, value });
    }
  }
}

function scanLine(line: string, lineNo: number, out: RuleMatch[]): void {
  if (line.length <= WINDOW_SIZE) {
    scanWindow(line, lineNo, out, true);
    return;
  }
  const step = WINDOW_SIZE - WINDOW_OVERLAP;
  for (let start = 0; start < line.length; start += step) {
    const end = Math.min(start + WINDOW_SIZE, line.length);
    const isFinalWindow = end === line.length;
    scanWindow(line.slice(start, end), lineNo, out, isFinalWindow);
    if (isFinalWindow) break;
  }
}

/**
 * Scan `text` line by line (1-based) for secret-shaped values.
 * NOT exported from `core/src/index.ts` — only `scanner.ts`'s tests and
 * `scanText` may call this directly.
 */
export function matchRules(text: string): RuleMatch[] {
  const matches: RuleMatch[] = [];
  let lineNo = 0;
  let idx = 0;
  const len = text.length;
  while (idx <= len) {
    lineNo++;
    const nl = text.indexOf('\n', idx);
    const lineEnd = nl === -1 ? len : nl;
    const line = text.slice(idx, lineEnd).replace(/\r$/, '');
    scanLine(line, lineNo, matches);
    if (nl === -1) break;
    idx = nl + 1;
  }
  return matches;
}
