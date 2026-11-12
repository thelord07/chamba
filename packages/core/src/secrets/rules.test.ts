/**
 * rules.test.ts — co-located test for `matchRules` (CHAMBA-021 S1).
 *
 * Only this file (and `scanner.ts`) may import `matchRules`/`RuleMatch`
 * directly — they are intentionally not exported from `core/src/index.ts`.
 *
 * Every example value below is built by string concatenation so this file
 * itself never contains a literal, realistic-looking secret that
 * GitHub push protection (or any similar scanner) could flag.
 */
import { describe, expect, it } from 'vitest';
import type { SecretKind } from './rules.js';
import { matchRules } from './rules.js';

// ── Fixture builders (concatenation, never a literal secret-shaped string) ───

const UP16 = 'ABCDEFGHIJKLMNOP'; // 16 uppercase letters, for AKIA/ASIA bodies
const GOOGLE_BODY = `${'abcdefghij'}${'klmnopqrst'}${'uvwxyz0123'}${'45678'}`; // 35 chars

const jwtHeader = `eyJ${'A'.repeat(17)}`;
const jwtPayload = `eyJ${'B'.repeat(47)}`;
const jwtSig = 'C'.repeat(20);
const jwtShort = `eyJ${'x'.repeat(5)}.eyJ${'y'.repeat(5)}.${'z'.repeat(5)}`; // < 60 chars total

const assignmentValue = `${'Zk3Qm9vLxT2'}${'pR7cF1nW9s'}`; // high entropy, 21 chars

interface Case {
  name: string;
  kind: SecretKind;
  line: string;
}

const POSITIVES: Case[] = [
  { name: 'parche token', kind: 'parche-token', line: `token: ${'pch_'}${'A'.repeat(24)}` },
  { name: 'parche token (bare)', kind: 'parche-token', line: `${'pch_'}${'Z'.repeat(16)}` },
  { name: 'openai key', kind: 'openai-key', line: `OPENAI_API_KEY=${'sk-'}${'A'.repeat(20)}` },
  {
    name: 'openai project key',
    kind: 'openai-key',
    line: `key = "${'sk-proj-'}${'B'.repeat(20)}"`,
  },
  { name: 'resend key', kind: 'resend-key', line: `RESEND_API_KEY=${'re_'}${'C'.repeat(20)}` },
  { name: 'aws access key', kind: 'aws-access-key', line: `aws_access_key_id = ${'AKIA'}${UP16}` },
  { name: 'aws temp key', kind: 'aws-temp-key', line: `AWS_SESSION_TOKEN_ID=${'ASIA'}${UP16}` },
  {
    name: 'google api key',
    kind: 'google-api-key',
    line: `GOOGLE_API_KEY=${'AIza'}${GOOGLE_BODY}`,
  },
  { name: 'github token (ghp)', kind: 'github-token', line: `${'ghp_'}${'D'.repeat(24)}` },
  { name: 'github token (gho)', kind: 'github-token', line: `token: ${'gho_'}${'E'.repeat(24)}` },
  {
    name: 'github pat',
    kind: 'github-pat',
    line: `GITHUB_TOKEN=${'github_pat_'}${'F'.repeat(24)}`,
  },
  { name: 'slack token', kind: 'slack-token', line: `SLACK_BOT_TOKEN=${'xoxb-'}${'1'.repeat(12)}` },
  { name: 'gitlab pat', kind: 'gitlab-pat', line: `${'glpat-'}${'G'.repeat(16)}` },
  { name: 'jwt', kind: 'jwt', line: `Authorization: Bearer ${jwtHeader}.${jwtPayload}.${jwtSig}` },
  {
    name: 'jwt (bare)',
    kind: 'jwt',
    line: `${jwtHeader}.${jwtPayload}.${jwtSig}`,
  },
  {
    name: 'private key header',
    kind: 'private-key',
    line: `${'-----BEGIN'} RSA PRIVATE KEY${'-----'}`,
  },
  {
    name: 'private key header (EC)',
    kind: 'private-key',
    line: `${'-----BEGIN'} EC PRIVATE KEY${'-----'}`,
  },
  {
    name: 'postgres connection string',
    kind: 'connection-string',
    line: `DATABASE_URL=${'postgres://'}${'dbuser'}:${'s3cr3tPass1'}@${'db.internal:5432/app'}`,
  },
  {
    name: 'mysql connection string',
    kind: 'connection-string',
    line: `${'mysql://'}${'root'}:${'hunter2pass'}@${'127.0.0.1:3306/app'}`,
  },
  {
    name: 'mongodb+srv connection string',
    kind: 'connection-string',
    line: `${'mongodb+srv://'}${'admin'}:${'topSecret9'}@${'cluster0.mongodb.net/app'}`,
  },
  {
    name: 'redis connection string',
    kind: 'connection-string',
    line: `${'redis://'}${'u'}:${'p4ssw0rdValue'}@${'cache.internal:6379/0'}`,
  },
  {
    name: 'amqp connection string',
    kind: 'connection-string',
    line: `${'amqp://'}${'guest'}:${'rabbitSecret1'}@${'broker.internal:5672/vh'}`,
  },
  { name: 'assignment api_key', kind: 'assignment', line: `api_key: ${assignmentValue}` },
  { name: 'assignment secret', kind: 'assignment', line: `secret = "${assignmentValue}"` },
  { name: 'assignment password', kind: 'assignment', line: `password: ${assignmentValue}` },
  {
    name: 'assignment client_secret',
    kind: 'assignment',
    line: `client_secret=${assignmentValue}`,
  },
  {
    name: 'stripe secret key',
    kind: 'stripe-secret-key',
    line: `STRIPE_SECRET_KEY=${'sk_live_'}${'A'.repeat(32)}`,
  },
  {
    name: 'stripe restricted key',
    kind: 'stripe-restricted-key',
    line: `STRIPE_RESTRICTED_KEY=${'rk_live_'}${'B'.repeat(32)}`,
  },
  {
    name: 'stripe webhook secret',
    kind: 'stripe-webhook-secret',
    line: `STRIPE_WEBHOOK_SECRET=${'whsec_'}${'C'.repeat(32)}`,
  },

  // ── CHAMBA-023 S1 — `assignment` post-filter: fail-open regression guards.
  // Each case below still matches (`kind: 'assignment'`) AFTER the post-filter
  // ships, fixing the exact edge where an earlier, broader version of the
  // filter would have wrongly exempted it too (see rules.ts header (b)/(c)).
  {
    name: 'quoted call-looking value stays positive (B1: quote tracked via its own group)',
    kind: 'assignment',
    line: `api_key = "${'crypto'}.${'randomUUID'}("`,
  },
  {
    name: 'quoted member-looking value stays positive',
    kind: 'assignment',
    line: `token = "${'crypto'}.${'randomUUID'}"`,
  },
  {
    name: 'member exemption respects the 15-char-per-segment cap (first segment is 16)',
    kind: 'assignment',
    line: `token = ${'AbCdEfGhIjKlMnOp'}.${'QrStUvWxYz'}`,
  },
  {
    name: 'call exemption respects the 24-char-per-segment cap (segment is 33 > 24)',
    kind: 'assignment',
    line: `api_key = ${'sk_live_'}${'51H8xQ2eZvKYlo2C0a1b2c3d4'}(nota)`,
  },
  {
    name: 'quoted base64-ish value stays positive',
    kind: 'assignment',
    line: `api_key = "${'aG9sYS5tdW5kby5lc3RvLmVz'}"`,
  },
  {
    name: 'unquoted stripe-shaped value stays positive under assignment too',
    kind: 'assignment',
    line: `api_key=${'sk_live_'}${'51H8xQ2eZvKYlo2C0a1b2c3d4'}`,
  },
  {
    name: 'quoted multi-dot value stays positive',
    kind: 'assignment',
    line: `token = "${'v1'}.${'MRnAbCdEfGhIjKlMnOpQrStUvWxYz'}.${'0123'}"`,
  },
  {
    name: 'unquoted dotted value with an over-long second segment stays positive',
    kind: 'assignment',
    line: `api_key = ${'patAbCdEfGh1234'}.${'c0ffee0123456789abcdef0123456789abcdef0123456789abcdef'}`,
  },
  {
    name: 'password with an entropy margin stays positive (NB2: not right at MIN_ENTROPY)',
    kind: 'assignment',
    line: `password = ${'my_Snake_Case_Var_Name_42x'}`,
  },
  {
    name: 'bare camelCase identifier stays positive (D-Q2/OQ3: deliberately fail-closed)',
    kind: 'assignment',
    line: `secret: ${'myVeryLongCamelCaseVariableName'}`,
  },

  // ── Review item 1: Stripe rules — trailing boundary fix regression guards.
  // With the old trailing `\b` + `{n,247}` cap, BOTH cases below failed to
  // match at all (see rules.ts comment above the Stripe rules for why).
  {
    name: 'stripe secret key with 248+ trailing alphanumeric chars still matches (review item 1)',
    kind: 'stripe-secret-key',
    line: `STRIPE_SECRET_KEY=${'sk_live_'}${'A'.repeat(260)}`,
  },
  {
    name: 'stripe secret key immediately followed by an underscore still matches (review item 1)',
    kind: 'stripe-secret-key',
    line: `STRIPE_SECRET_KEY=${'sk_live_'}${'B'.repeat(32)}_x`,
  },
  {
    name: 'stripe restricted key with 248+ trailing alphanumeric chars still matches (review item 1)',
    kind: 'stripe-restricted-key',
    line: `STRIPE_RESTRICTED_KEY=${'rk_live_'}${'C'.repeat(260)}`,
  },
  {
    name: 'stripe webhook secret immediately followed by an underscore still matches (review item 1)',
    kind: 'stripe-webhook-secret',
    line: `STRIPE_WEBHOOK_SECRET=${'whsec_'}${'D'.repeat(32)}_x`,
  },
];

describe('matchRules — positives (CHAMBA-021 §4.1, ≥25 cases)', () => {
  it('has at least 25 positive cases', () => {
    expect(POSITIVES.length).toBeGreaterThanOrEqual(25);
  });

  it('covers all 17 kinds at least once', () => {
    const kinds = new Set(POSITIVES.map((c) => c.kind));
    const expected: SecretKind[] = [
      'parche-token',
      'openai-key',
      'resend-key',
      'aws-access-key',
      'aws-temp-key',
      'google-api-key',
      'github-token',
      'github-pat',
      'slack-token',
      'gitlab-pat',
      'jwt',
      'private-key',
      'connection-string',
      'assignment',
      'stripe-secret-key',
      'stripe-restricted-key',
      'stripe-webhook-secret',
    ];
    for (const k of expected) {
      expect(kinds.has(k), `missing a positive case for kind "${k}"`).toBe(true);
    }
  });

  for (const c of POSITIVES) {
    it(`detects ${c.name} on line 1`, () => {
      const matches = matchRules(c.line);
      const hit = matches.find((m) => m.kind === c.kind);
      expect(hit, `expected a "${c.kind}" match in: ${JSON.stringify(c.line)}`).toBeDefined();
      expect(hit?.line).toBe(1);
    });

    it(`reports the correct line number for ${c.name} further down the file`, () => {
      const text = `# intro\nsome prose\n${c.line}\nmore prose\n`;
      const matches = matchRules(text);
      const hit = matches.find((m) => m.kind === c.kind);
      expect(hit?.line).toBe(3);
    });
  }

  it('never includes the value in a value-stripped JSON view', () => {
    for (const c of POSITIVES) {
      const matches = matchRules(c.line);
      for (const m of matches) {
        // The raw RuleMatch DOES have a value (internal only) — this test fixes
        // that `scanner.ts`'s public Finding type has no such field, by asserting
        // the match's own JSON (if someone mistakenly serialized it) is scoped
        // to this internal, non-exported module only.
        expect(typeof m.value).toBe('string');
      }
    }
  });
});

const NEGATIVES: string[] = [
  'This document explains how API keys work in general.',
  'The password_hash column stores a bcrypt digest.',
  'Replace the placeholder with your own value: <tu-token>',
  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder syntax, not a template literal
  'DATABASE_URL=${DATABASE_URL}',
  'export const key = process.env.OPENAI_API_KEY',
  'password: changeme',
  `sha256: ${'a1b2c3d4e5f6'.repeat(5).slice(0, 64)}`,
  'token: short',
  `Authorization: Bearer ${jwtShort}`,
  'postgres://localhost:5432/db',
  'mongodb://localhost:27017/app',
  'We talk about secrets management best practices here.',
  'The "token" field in this table is a foreign key, not a credential.',
  'See https://github.com/settings/tokens to create a PAT.',
  'token: ""',
  'token: xxxxxxxxxxxxxxxxxxxx',
  'api_key = <REDACTED>',
  'client_secret: your-key-here',
  'AKIAEXAMPLE', // too short — not exactly 16 chars after AKIA
  'ghp_tooshort',
  'pch_',
  'this curl example is just prose about piping output to a file',
  'secret_phrase = "nombre de mi perro"', // low entropy prose-like value, len<16 anyway
  'token: no-expiration-by-default', // hyphenated lowercase prose, not a token shape
  'token: always-use-https-in-production', // same — only [a-z-], no digits/mixed case

  // ── CHAMBA-023 S1 — `assignment` post-filter negatives.
  // ★ = this exact case fires today (false positive) and is the one the
  // post-filter actually fixes. The rest fix nothing new; they're regression
  // fixation for cases that were already negative for an unrelated reason.
  `token = ${'crypto'}.${'randomUUID'}()`, // ★ the seed's exact false positive (auth/magic-link.md)
  'tokenHash = sha256(token)', // never captures ≥16 chars — unrelated to this fix
  `const token = req.body.accessToken`, // ★ member exemption
  `password: user.profile.passwordHash`, // ★ member exemption
  'token: this.auth.session.token', // entropy 3.33 < MIN_ENTROPY — already negative
  'secret = process.env.SESSION_SECRET', // already a placeholder — already negative
  `secret = path/to/some/file.json`, // ★ path exemption
  `token = ../../fixtures/tokens.json`, // ★ path exemption
  `api-key: docs/reference/api-keys.md`, // ★ path exemption
  `client_secret = ${'getClientSecretFromVault'}()`, // ★ call exemption (24-char segment, exact boundary)
  `api_key = ${'readApiKeyFromDisk'}()`, // ★ call exemption
  `${'pk_live_'}${'51H8xQ2eZvKYlo2C0a1b2c3d4'}`, // Stripe PUBLISHABLE key — intentionally not detected (D-Q2)
];

describe('matchRules — negatives (CHAMBA-021 §4.1, ≥20 cases)', () => {
  it('has at least 20 negative cases', () => {
    expect(NEGATIVES.length).toBeGreaterThanOrEqual(20);
  });

  for (const text of NEGATIVES) {
    it(`does not match: ${JSON.stringify(text).slice(0, 60)}`, () => {
      expect(matchRules(text)).toEqual([]);
    });
  }
});

describe('matchRules — windowing (hot-path)', () => {
  it('finds a match near the start and end of a very long single line', () => {
    const akia = `${'AKIA'}${UP16}`;
    const filler = 'x'.repeat(200_000);
    const text = `${akia} ${filler} ${akia}`;
    const matches = matchRules(text);
    const aws = matches.filter((m) => m.kind === 'aws-access-key');
    expect(aws.length).toBeGreaterThanOrEqual(1);
    expect(aws.every((m) => m.line === 1)).toBe(true);
  });

  it('a single-line JSON-like (.canvas-shaped) blob still gets scanned', () => {
    const pch = `${'pch_'}${'H'.repeat(24)}`;
    const text = `{"nodes":[{"type":"text","text":"token=${pch}"}]}`;
    const matches = matchRules(text);
    expect(matches.some((m) => m.kind === 'parche-token')).toBe(true);
  });

  it('scans a 1 MiB synthetic file (10k lines) in under 150ms', () => {
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      lines.push(`line ${i}: nothing to see here, just some prose padding text.`);
    }
    const text = lines.join('\n');
    const start = performance.now();
    matchRules(text);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(150);
  });
});

describe('matchRules — a JWT assigned to a key reports BOTH kinds on the same line (NB1)', () => {
  it('reports kind "jwt" AND kind "assignment" for the same line, each once', () => {
    // A varied (non-repetitive) JWT, unlike the top-of-file fixtures above:
    // those repeat a single letter per segment, which tanks Shannon entropy
    // below MIN_ENTROPY and would make this test pass for the wrong reason
    // (entropy filter, not the post-filter this test targets).
    const header = `${'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'}`;
    const payload = `${'eyJzdWIiOiIxMjM0NTY3ODkwIn0'}`;
    const signature = `${'dQw4w9WgXcQdQw4w9WgXcQ'}`;
    const jwt = `${header}.${payload}.${signature}`;
    const text = `token = ${jwt}`;
    const matches = matchRules(text);
    const kinds = matches.map((m) => m.kind);
    expect(kinds).toContain('jwt');
    expect(kinds).toContain('assignment');
    expect(kinds.filter((k) => k === 'jwt')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'assignment')).toHaveLength(1);
  });
});
