import { describe, expect, it } from 'vitest';
import { FakeHash } from '../testing/fake-hash.js';
import { isScannable, scanText, scanWriteFields } from './scanner.js';

const AKIA_BODY = 'ABCDEFGHIJKLMNOP';

describe('isScannable', () => {
  it('accepts .md, .canvas, .base, .svg', () => {
    expect(isScannable('notes/a.md')).toBe(true);
    expect(isScannable('board.canvas')).toBe(true);
    expect(isScannable('data.base')).toBe(true);
    expect(isScannable('diagram.svg')).toBe(true);
  });

  it('rejects raster images, PDFs, and other extensions (out of scope)', () => {
    expect(isScannable('diagram.png')).toBe(false);
    expect(isScannable('report.pdf')).toBe(false);
    expect(isScannable('schema.sql')).toBe(false);
    expect(isScannable('readme')).toBe(false);
  });
});

describe('scanText', () => {
  it('never includes the detected value — only path/line/kind/fingerprint', async () => {
    const hash = new FakeHash();
    const value = `${'pch_'}${'TESTSECRET'}${'Z'.repeat(16)}`;
    const text = `# note\n\ntoken: ${value}\n`;
    const findings = await scanText({ hash }, text, 'x.md');
    expect(findings.length).toBeGreaterThan(0);
    const json = JSON.stringify(findings);
    expect(json).not.toContain(value);
    expect(json).not.toContain('TESTSECRET');
    for (const f of findings) {
      expect(Object.keys(f).sort()).toEqual(['fingerprint', 'kind', 'line', 'path'].sort());
    }
  });

  it('is deterministic and stable across platforms (same input -> same fingerprint)', async () => {
    const hash = new FakeHash();
    const text = `${'AKIA'}${AKIA_BODY}`;
    const [a, b] = await Promise.all([
      scanText({ hash }, text, 'x.md'),
      scanText({ hash }, text, 'x.md'),
    ]);
    expect(a).toEqual(b);
    expect(a[0]?.fingerprint).toMatch(/^[0-9a-f]{12}$/);
  });

  it('the same value under a different kind produces a different fingerprint', async () => {
    const hash = new FakeHash();
    const value = 'sameRandomishValue1234567890';
    const a = await scanText({ hash }, `api_key: ${value}`, 'a.md');
    const b = await scanText({ hash }, `${'pch_'}${value}`, 'b.md');
    // a is kind=assignment, b is kind=parche-token — different kinds
    expect(a[0]?.kind).not.toBe(b[0]?.kind);
    expect(a[0]?.fingerprint).not.toBe(b[0]?.fingerprint);
  });

  it('the same value at two different paths produces the SAME fingerprint (allowlist requirement)', async () => {
    const hash = new FakeHash();
    const text = `${'AKIA'}${AKIA_BODY}`;
    const a = await scanText({ hash }, text, 'path/one.md');
    const b = await scanText({ hash }, text, 'path/two.md');
    expect(a[0]?.fingerprint).toBe(b[0]?.fingerprint);
    expect(a[0]?.path).not.toBe(b[0]?.path);
  });

  it('dedupes findings at the same (line, kind, fingerprint)', async () => {
    const hash = new FakeHash();
    const value = `${'AKIA'}${AKIA_BODY}`;
    // Place the SAME full match inside the overlap region shared by windows 1
    // and 2 (window1 = [0, 65536), window2 starts at 65536-16384=49152), so
    // the real match is captured whole by both windows — dedupe must collapse
    // that to a single Finding.
    const WINDOW_SIZE = 64 * 1024;
    const start = WINDOW_SIZE - 300; // well inside [49152, 65536), not touching the edge
    // Filler is non-word ('.') so it never merges into the match (AKIA's rule
    // requires a `\b` word boundary, and 'a'/'z' filler would break that).
    const text = `${'.'.repeat(start)}${value}${'.'.repeat(2_000)}`;
    const findings = await scanText({ hash }, text, 'x.md');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(1);
  });

  describe('windowing — a straddling match is reported exactly once, with the FULL value (review fix)', () => {
    const WINDOW_SIZE = 64 * 1024;

    it('a pch_ token placed exactly across the 64 KiB window boundary → one finding', async () => {
      const hash = new FakeHash();
      const token = `${'pch_'}${'Q'.repeat(28)}`; // 32 chars
      // Start 20 chars before the boundary: window 1 sees "pch_" + 16 chars
      // (still ≥ the rule's 8-char minimum, so it DOES match — truncated,
      // wrong fingerprint — if the straddle bug is present). Window 2 then
      // captures the full 32-char token intact. Filler is non-word ('.') so
      // it never merges into the token's own character class.
      const start = WINDOW_SIZE - 20;
      const text = `${'.'.repeat(start)}${token}${'.'.repeat(2_000)}`;

      const findings = await scanText({ hash }, text, 'canvas.canvas');
      const alone = await scanText({ hash }, token, 'canvas.canvas');

      expect(findings).toHaveLength(1);
      expect(findings[0]?.kind).toBe('parche-token');
      expect(findings[0]?.fingerprint).toBe(alone[0]?.fingerprint);
    });

    it('a ~1200-char JWT placed exactly across the 64 KiB window boundary → one finding', async () => {
      const hash = new FakeHash();
      const header = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9';
      const payload = `eyJ${'A'.repeat(900)}`;
      const signature = 'S'.repeat(250);
      const jwt = `${header}.${payload}.${signature}`; // ~1200 chars
      expect(jwt.length).toBeGreaterThan(1100);

      // Start so window 1 sees both dots and PART of the signature segment
      // (header 37 + '.' + payload 903 + '.' = 942 chars in) — truncating
      // there still matches (a shorter signature), producing a truncated,
      // WRONG-fingerprint finding if the straddle bug is present. Filler is
      // non-word ('.') so the leading `\b` before "eyJ" still holds.
      const start = WINDOW_SIZE - 1_000;
      const text = `${'.'.repeat(start)}${jwt}${'.'.repeat(2_000)}`;

      const findings = await scanText({ hash }, text, 'canvas.canvas');
      const alone = await scanText({ hash }, jwt, 'canvas.canvas');

      expect(findings).toHaveLength(1);
      expect(findings[0]?.kind).toBe('jwt');
      expect(findings[0]?.fingerprint).toBe(alone[0]?.fingerprint);
    });
  });

  describe('windowing — matches longer than 4096 straddling a boundary (review ronda 2)', () => {
    const WINDOW_SIZE = 64 * 1024;

    it('a ~9000-char JWT straddling the window boundary is still detected once (no fail-open)', async () => {
      const hash = new FakeHash();
      const jwt = `${'eyJ'}${'A'.repeat(4000)}.${'eyJ'}${'B'.repeat(4000)}.${'C'.repeat(1000)}`;
      expect(jwt.length).toBeGreaterThan(9000);
      const start = WINDOW_SIZE - 6_096; // crosses the 64 KiB edge by ~3000 chars
      const text = `${'.'.repeat(start)}${jwt}${'.'.repeat(80_000)}`;
      const findings = await scanText({ hash }, text, 'big.canvas');
      const alone = await scanText({ hash }, jwt, 'big.canvas');
      expect(alone).toHaveLength(1);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.fingerprint).toBe(alone[0]?.fingerprint);
    });

    it('a ~4090-char assigned value straddling the boundary is still detected once', async () => {
      const hash = new FakeHash();
      let value = '';
      const alphabet = 'AbCdEfGh0123456789XyZqRsTuVw';
      for (let i = 0; i < 4090; i++) value += alphabet[(i * 5) % alphabet.length];
      const assignment = `password="${value}"`;
      const start = WINDOW_SIZE - 2_000;
      const text = `${' '.repeat(start)}${assignment}${' '.repeat(80_000)}`;
      const findings = await scanText({ hash }, text, 'big.md');
      const alone = await scanText({ hash }, assignment, 'big.md');
      expect(alone).toHaveLength(1);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.fingerprint).toBe(alone[0]?.fingerprint);
    });
  });

  describe('password-like keys keep detecting diceware passphrases (review ronda 2)', () => {
    it.each([
      `password: ${'tiger'}-castle-maple-river`,
      `secret = "${'marble'}-quiver-junction-sputnik"`,
      `passwd=${'violet'}-anchor-pepper-glacier`,
    ])('detects %s', async (line) => {
      const findings = await scanText({ hash: new FakeHash() }, line, 'x.md');
      expect(findings).toHaveLength(1);
      expect(findings[0]?.kind).toBe('assignment');
    });

    it('still skips hyphenated prose for non-password keys', async () => {
      const findings = await scanText(
        { hash: new FakeHash() },
        'token: no-expiration-by-default',
        'x.md',
      );
      expect(findings).toHaveLength(0);
    });
  });

  it('sorts by line ascending, then kind ascending', async () => {
    const hash = new FakeHash();
    const value1 = `${'AKIA'}${AKIA_BODY}`;
    const value2 = `${'ASIA'}${AKIA_BODY}`;
    const text = `${value1}\n${value2}\n${value1}`;
    const findings = await scanText({ hash }, text, 'x.md');
    const lines = findings.map((f) => f.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });
});

describe('scanWriteFields (D-Q1: write-time gate)', () => {
  it('finds a secret in any of title/summary/keywords/content, reporting its field name', async () => {
    const hash = new FakeHash();
    const secret = `${'AKIA'}${AKIA_BODY}`;
    const findings = await scanWriteFields({ hash }, [
      { field: 'title', value: 'title ok' },
      { field: 'summary', value: 'summary ok' },
      { field: 'keywords', value: ['kw1', secret] },
      { field: 'content', value: 'content ok' },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe('aws-access-key');
    expect(findings[0]?.field).toBe('keywords');
    // The secret is the 2nd "line" of the joined keywords array.
    expect(findings[0]?.line).toBe(2);
  });

  it("reports each field's own 1-based line, never offset by a field scanned before it", async () => {
    const hash = new FakeHash();
    const secret = `${'AKIA'}${AKIA_BODY}`;
    // The secret sits on line 3 of `content`. If fields were joined together
    // (title, then summary, then content) the reported line would be offset
    // by the lines in title/summary — it must still read 3.
    const findings = await scanWriteFields({ hash }, [
      { field: 'title', value: 'a plan title' },
      { field: 'summary', value: 'a one-line summary' },
      { field: 'content', value: `line one\nline two\n${secret}\n` },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.field).toBe('content');
    expect(findings[0]?.line).toBe(3);
  });

  it('returns [] when nothing matches', async () => {
    const hash = new FakeHash();
    const findings = await scanWriteFields({ hash }, [
      { field: 'title', value: 'title' },
      { field: 'summary', value: undefined },
      { field: 'keywords', value: undefined },
      { field: 'content', value: 'content' },
    ]);
    expect(findings).toEqual([]);
  });

  it('ignores undefined fields', async () => {
    const hash = new FakeHash();
    const findings = await scanWriteFields({ hash }, [
      { field: 'title', value: undefined },
      { field: 'content', value: undefined },
    ]);
    expect(findings).toEqual([]);
  });
});
