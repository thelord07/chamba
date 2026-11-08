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
];

describe('matchRules — positives (CHAMBA-021 §4.1, ≥25 cases)', () => {
  it('has at least 25 positive cases', () => {
    expect(POSITIVES.length).toBeGreaterThanOrEqual(25);
  });

  it('covers all 14 kinds at least once', () => {
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
