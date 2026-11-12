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
 *
 * CHAMBA-023 S1 — `assignment` false-positive fix, post-filter design:
 * (a) The fix is a POST-FILTER applied to the value the regex already
 *     captured, never a change to the capturing character class. The capture
 *     group added for the opening quote (`(['"]?)`) does not change what the
 *     regex consumes, so the captured `value` — and therefore
 *     `fingerprint = sha256(kind + "\n" + value)` — is byte-for-byte identical
 *     for every finding that still survives. This keeps existing allowlists
 *     and `blockedSecret` state valid across the fix (see `rules.test.ts`'s
 *     fingerprint-snapshot test). Narrowing the character class instead (e.g.
 *     dropping `.`) would silently truncate some captured values and change
 *     their fingerprint, invalidating live allowlists on both this client and
 *     the server — that's why it's out of scope here.
 * (b) The three exemptions below (`call`, `member`, `path`) only apply when
 *     the value is UNQUOTED (`quoted === false`): a quoted literal is, by
 *     definition, an actual value a human chose to write down, so it's
 *     fail-closed regardless of its shape. `member`'s only evidence that a
 *     value is code (not a secret) is "it contains a dot" — a weak signal —
 *     so each dotted segment is capped at 15 chars. `call`'s evidence is
 *     stronger (the value is immediately followed by `(`, i.e. it's a
 *     function/method call), so it allows longer segments, capped at 24 —
 *     just enough for names like `getClientSecretFromVault`.
 * (c) Residual gap (accepted risk, not closed by this fix): ANY UNQUOTED,
 *     dot-separated chain of segments is exempted by `member` as long as
 *     EVERY segment matches `[A-Za-z_$][A-Za-z0-9_$]*` (so a segment may
 *     start with a letter, `_`, or `$` — not only a letter) AND is ≤ 15
 *     chars, AND the whole value is ≤ 64 chars total — regardless of
 *     whether it's a real identifier chain or just a string that happens to
 *     have that shape. `token = aGVsbG8.d29ybGQ.c2VjcmV0` is only ONE
 *     example of this; the gap is the general shape, not that specific
 *     base64-ish look. Quoted values have no such gap (always fail-closed).
 *     None of the known provider formats (`pch_`, `sk-`, `AKIA`, `jwt`, …) go
 *     through this post-filter — they match by shape in their own rules below.
 * (d) Parity note (CHAMBA-023 §1.10): the server runs this SAME rule table
 *     over every blob it receives, but it only ever sees bytes the client
 *     chose to sync (`isSyncable` in `sync-filter.ts` excludes `.env*`,
 *     `.chamba-sync*`, `.trash/`, `.obsidian/workspace*`, and any
 *     non-allowed extension). For those never-synced paths, THIS module's
 *     rules are the only guard there is — any exemption added here applies
 *     unconditionally to them too, with no server-side second check.
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
  | 'assignment'
  | 'stripe-secret-key'
  | 'stripe-restricted-key'
  | 'stripe-webhook-secret';

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

/** Context passed to a rule's `postFilter`. Never contains more than this. */
interface PostFilterContext {
  /** The captured value — identical to what would have been pushed without the filter. */
  value: string;
  /** True when the value was wrapped in `'` or `"` in the source text. */
  quoted: boolean;
  /** The single character right after the match in the scanned window, or `''` at the window's final edge. */
  after: string;
}

interface Rule {
  kind: SecretKind;
  /** Must be a global regex (`g` flag). */
  re: RegExp;
  entropyChecked?: boolean;
  /** Extra post-filter (e.g. JWT minimum total length). */
  extra?: (value: string) => boolean;
  /**
   * Generic post-filter over the already-captured value (CHAMBA-023 S1).
   * Returns `true` to DISCARD the match. Only `assignment` uses this today;
   * it's generic on the `Rule` type so a future shape-prefixed rule could
   * reuse it without another ad hoc field.
   */
  postFilter?: (ctx: PostFilterContext) => boolean;
}

// ── Bounded helpers for the `assignment` post-filter (CHAMBA-023 S1) ────────
// Every helper below works on an already-length-capped value (≤ 4096 chars,
// enforced by the regex capture bound) and does its own early-exit length
// checks before running any regex, so none can backtrack catastrophically —
// no nested variable-length quantifiers over the same character class.

/** A single identifier segment: `crypto`, `randomUUID`, `getClientSecretFromVault`. */
const IDENTIFIER_SEGMENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * True when `value` is a dot-separated chain of identifier segments (no `/`,
 * `+`, or `-` anywhere — those belong to paths/base64, not code), each
 * segment ≤ `maxSegmentLen` chars, and the whole value ≤ 64 chars total.
 * Splitting on `.` and testing each segment keeps this O(len) with no
 * backtracking, instead of one regex with a repeated group.
 */
function isDottedIdentifierChain(value: string, maxSegmentLen: number): boolean {
  if (value.length === 0 || value.length > 64) return false;
  for (const segment of value.split('.')) {
    if (segment.length === 0 || segment.length > maxSegmentLen) return false;
    if (!IDENTIFIER_SEGMENT_RE.test(segment)) return false;
  }
  return true;
}

/** Exemption 1 (`call`): `token = crypto.randomUUID()`, `secret = readSecretFromVault()`. */
function isCallException(value: string, after: string): boolean {
  return after === '(' && isDottedIdentifierChain(value, 24);
}

/** Exemption 2 (`member`): `crypto.randomUUID`, `req.body.accessToken` (no trailing call). */
function isMemberException(value: string): boolean {
  return value.includes('.') && isDottedIdentifierChain(value, 15);
}

const PATH_SHAPE_RE = /^(?:\.{1,2}\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_.-]+)+$/;
const PATH_EXTENSION_RE = /\.[a-z]{1,8}$/;

/** Exemption 3 (`path`): `path/to/some/file.json`, `../../fixtures/tokens.json`. */
function isPathException(value: string): boolean {
  // Length check first and unconditionally — bounds the two character-class
  // regexes below to ≤ 160 chars before they ever run.
  if (value.length === 0 || value.length > 160 || !value.includes('/')) return false;
  return PATH_SHAPE_RE.test(value) && PATH_EXTENSION_RE.test(value);
}

/**
 * The `assignment` rule's post-filter (CHAMBA-023 S1). All three exemptions
 * require `!quoted` — see the module header (b) for why a quoted value is
 * always fail-closed regardless of shape.
 */
function assignmentPostFilter(ctx: PostFilterContext): boolean {
  if (ctx.quoted) return false;
  return (
    isCallException(ctx.value, ctx.after) ||
    isMemberException(ctx.value) ||
    isPathException(ctx.value)
  );
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
  // CHAMBA-023 D-Q2 (owner decision): Stripe keys/secrets, matched purely by
  // shape — independent of `assignment`, so a bare `sk_live_…` with no
  // `key = `/`secret: ` prefix nearby is still caught. `pk_live_` (Stripe's
  // PUBLISHABLE key) is intentionally NOT a rule here — it's meant to be
  // public (see the `pk_live_` NEGATIVE case in rules.test.ts).
  //
  // Review item 1 fix: the trailing boundary is `(?![A-Za-z0-9])`, not `\b`.
  // `\b` tests a transition between \w and \W — and `_` IS \w — so with a
  // trailing `\b`, `sk_live_<32 chars>_x` would never match: ANY cut point
  // within a run that's followed by `_` fails the \w/\W transition test,
  // since both sides are \w. `(?![A-Za-z0-9])` only cares whether the next
  // char is alphanumeric, so it correctly stops at (and accepts) a `_`.
  // The upper bound is `4096`, matching every other rule in this table (see
  // the module header: "≤ 4096 per capturing span") — NOT the old `247`,
  // which was tight enough to break on its own: `sk_live_` followed by 248+
  // alphanumeric chars would never match AT ALL. With ANY trailing boundary
  // assertion, every cut point the quantifier tries from 16 up to the cap is
  // still followed by MORE alphanumeric characters (since the real run is
  // longer than the cap), so the assertion fails at every length, and the
  // whole rule silently never matches that line — `4096` is generous enough
  // that no real Stripe key shape runs into this. It also stays well under
  // the 16 KiB window overlap (module header), so a match can never be
  // split across a window boundary. `[A-Za-z0-9]{16,4096}` is a single,
  // non-nested, non-overlapping character class with no alternation —
  // matching stays O(n), and the one trailing lookahead adds only O(1).
  { kind: 'stripe-secret-key', re: /\bsk_live_[A-Za-z0-9]{16,4096}(?![A-Za-z0-9])/g },
  { kind: 'stripe-restricted-key', re: /\brk_live_[A-Za-z0-9]{16,4096}(?![A-Za-z0-9])/g },
  { kind: 'stripe-webhook-secret', re: /\bwhsec_[A-Za-z0-9]{24,4096}(?![A-Za-z0-9])/g },
  {
    kind: 'assignment',
    re: /(api[_-]?key|secret|password|passwd|token|client_secret)[ \t]{0,16}[:=][ \t]{0,16}(['"]?)([A-Za-z0-9/+_.-]{16,4096})['"]?/gi,
    entropyChecked: true,
    postFilter: assignmentPostFilter,
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
      // `assignment`'s regex has 3 groups: m[1] = key, m[2] = opening quote
      // (empty string when unquoted), m[3] = the value itself (CHAMBA-023 S1).
      const value = rule.kind === 'assignment' ? (m[3] ?? '') : m[0];
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
      if (rule.postFilter) {
        const quoted = (m[2] ?? '') !== '';
        // At a non-final window's right edge a touching match was already
        // dropped above (the next window sees it intact), so `after` only
        // ever reads '' here at the TRUE end of the scanned text — where no
        // exemption can apply. Fail-closed at the window boundary (NB3).
        const after = window[matchEnd] ?? '';
        if (rule.postFilter({ value, quoted, after })) continue;
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
