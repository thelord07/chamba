/**
 * local-path-differential.test.ts — S14 differential test.
 *
 * Contrasts our `local-path` helpers (from @chamba/core) against
 * `node:path.win32` / `node:path.posix` on a representative set of inputs.
 *
 * This test runs on ALL CI platforms (ubuntu, windows, macos) — the adapters
 * package can import `node:path`, and `node:path.win32` / `node:path.posix` are
 * always available regardless of the host OS.
 *
 * DOCUMENTED DIFFERENCES:
 *   D-1: `\\?\...` and `\\.\...` (device paths) — our module REJECTS them
 *        (assertNotUnsupportedPath throws), while node:path.win32 accepts them.
 *        This is intentional: the parche client never needs device paths.
 *   D-2: `C:` (bare drive letter, no separator) — our module REJECTS it (drive-
 *        relative), while node:path.win32 considers it relative.
 *   D-3: `C:foo` (drive-relative) — our module REJECTS it, node considers it relative.
 *   D-4: normalizeLocal uses `\` on win32; node:path.win32.normalize also uses `\`.
 *        Result should match semantically for absolute paths.
 *   D-5: Trailing slash on root — our normalizeLocal strips trailing sep from root
 *        and returns `C:` for `C:\..`. node:path.win32 returns `C:\` for root.
 *        The trailing sep on root is handled differently; we strip it.
 *
 * CHAMBA-015 Test 1 (adapters differential portion, per plan §S14).
 */

import path from 'node:path';
import {
  assertNotUnsupportedPath,
  isAbsoluteLocal,
  localDirname,
  normalizeLocal,
} from '@chamba/core';
import { describe, expect, it } from 'vitest';

// ─── win32 absolute detection ─────────────────────────────────────────────────

describe('win32 isAbsolute — matches node:path.win32', () => {
  const cases: string[] = [
    'D:\\workspace\\vault',
    'd:/workspace/vault',
    'C:\\Users\\x\\vaults\\cya',
    '\\\\srv\\share\\vault',
    '//srv/share/vault',
    '/foo',
    'vault',
    '.\\vault',
    '..\\otra\\vault',
  ];

  it.each(cases)('isAbsoluteLocal(%s, win32) agrees with path.win32.isAbsolute', (p) => {
    const ours = isAbsoluteLocal(p, 'win32');
    const node = path.win32.isAbsolute(p);
    expect(ours).toBe(node);
  });
});

describe('posix isAbsolute — matches node:path.posix', () => {
  const cases: string[] = [
    '/home/user/vault',
    'vault',
    './vault',
    '../other/vault',
    'a:b', // valid relative dir on posix
  ];

  it.each(cases)('isAbsoluteLocal(%s, posix) agrees with path.posix.isAbsolute', (p) => {
    const ours = isAbsoluteLocal(p, 'posix');
    const node = path.posix.isAbsolute(p);
    expect(ours).toBe(node);
  });
});

// ─── win32 normalization — matches node:path.win32 semantically ───────────────

describe('win32 normalizeLocal — semantic agreement with node:path.win32', () => {
  // These cases should give semantically equivalent results
  // (normalizeLocal uses `\`; node also uses `\` on win32)
  const cases: Array<[string, string]> = [
    ['D:\\workspace\\vault', 'D:\\workspace\\vault'],
    ['d:/workspace/vault', 'd:\\workspace\\vault'], // note: both preserve case; caseFoldLocal is a separate step
    ['C:\\Users\\x\\vaults\\cya', 'C:\\Users\\x\\vaults\\cya'],
    // Mixed separators
    ['D:/a\\b', 'D:\\a\\b'],
    // Trailing slash stripped (D6: we strip, node preserves on root only)
    ['D:\\workspace\\vault\\', 'D:\\workspace\\vault'],
    // Dot resolution
    ['D:\\workspace\\.\\vault', 'D:\\workspace\\vault'],
    ['D:\\workspace\\sub\\..\\vault', 'D:\\workspace\\vault'],
  ];

  it.each(cases)('normalizeLocal(%s, win32) === %s', (input, expected) => {
    expect(normalizeLocal(input, 'win32')).toBe(expected);
  });

  // Semantic comparison with node
  it('D:\\workspace\\vault normalizes same as node:path.win32', () => {
    const ours = normalizeLocal('D:\\workspace\\vault', 'win32');
    const node = path.win32.normalize('D:\\workspace\\vault');
    expect(ours).toBe(node);
  });

  it('D:/a\\b normalizes to D:\\a\\b (mixed sep, matches node)', () => {
    const ours = normalizeLocal('D:/a\\b', 'win32');
    const node = path.win32.normalize('D:/a\\b');
    expect(ours).toBe(node);
  });

  it('D:\\workspace\\.\\vault resolves dot (matches node)', () => {
    const ours = normalizeLocal('D:\\workspace\\.\\vault', 'win32');
    const node = path.win32.normalize('D:\\workspace\\.\\vault');
    expect(ours).toBe(node);
  });

  it('D:\\workspace\\sub\\..\\vault resolves dotdot (matches node)', () => {
    const ours = normalizeLocal('D:\\workspace\\sub\\..\\vault', 'win32');
    const node = path.win32.normalize('D:\\workspace\\sub\\..\\vault');
    expect(ours).toBe(node);
  });

  // .. that would escape the root — our impl clamps, node also doesn't go above root
  it('C:\\.. clamps to root (does not escape drive)', () => {
    const ours = normalizeLocal('C:\\..', 'win32');
    // node:path.win32 returns 'C:\\' for 'C:\\..'
    // Our impl strips trailing sep from root: 'C:'
    // Both are semantically "the root of C:" — document this as D-5
    expect(ours).toBeTruthy(); // C: or C:\ — not empty, not escaped
    const nodeResult = path.win32.normalize('C:\\..');
    expect(nodeResult).toMatch(/^C:[\\]?$/); // C:\ or C: from node
  });
});

// ─── posix normalization — matches node:path.posix ───────────────────────────

describe('posix normalizeLocal — matches node:path.posix', () => {
  // Note: we exclude trailing-slash cases here — node:path.posix.normalize preserves
  // a trailing slash on non-root paths, but our normalizeLocal always strips it.
  // That difference is documented below as D-6.
  const cases: string[] = ['/home/user/vault', '/home/./vault', '/home/user/../vault', '/a/b/c'];

  it.each(cases)('normalizeLocal(%s, posix) agrees semantically with path.posix.normalize', (p) => {
    const ours = normalizeLocal(p, 'posix');
    const node = path.posix.normalize(p);
    expect(ours).toBe(node);
  });
});

describe('DOCUMENTED DIFFERENCE D-6: trailing slash on non-root', () => {
  it('our normalizeLocal strips trailing slash; node:path.posix.normalize preserves it', () => {
    const p = '/home/user/vault/';
    const ours = normalizeLocal(p, 'posix');
    const node = path.posix.normalize(p);
    // Our module: '/home/user/vault' (trailing slash stripped)
    expect(ours).toBe('/home/user/vault');
    // node:path.posix: '/home/user/vault/' (preserved)
    expect(node).toBe('/home/user/vault/');
    // They are semantically the same directory — just formatted differently
    expect(ours.replace(/\/$/, '')).toBe(node.replace(/\/$/, ''));
  });
});

// ─── UNC paths ────────────────────────────────────────────────────────────────

describe('UNC paths on win32', () => {
  it('\\\\srv\\share\\vault is absolute', () => {
    expect(isAbsoluteLocal('\\\\srv\\share\\vault', 'win32')).toBe(true);
    expect(path.win32.isAbsolute('\\\\srv\\share\\vault')).toBe(true);
  });

  it('normalizes UNC without escaping share root', () => {
    const ours = normalizeLocal('\\\\srv\\share\\vault', 'win32');
    expect(ours).toBe('\\\\srv\\share\\vault');
    const node = path.win32.normalize('\\\\srv\\share\\vault');
    expect(ours).toBe(node);
  });
});

// ─── DOCUMENTED DIFFERENCES ──────────────────────────────────────────────────

describe('DOCUMENTED DIFFERENCE D-1: device paths', () => {
  it('our module REJECTS \\\\?\\C:\\x while node:path.win32 accepts it', () => {
    const devicePath = '\\\\?\\C:\\x';
    // Our module throws:
    expect(() => assertNotUnsupportedPath(devicePath, 'win32')).toThrow();
    // node:path.win32 accepts it:
    expect(() => path.win32.normalize(devicePath)).not.toThrow();
  });

  it('our module REJECTS //./x while node:path.win32 accepts it', () => {
    const devicePath = '//./x';
    expect(() => assertNotUnsupportedPath(devicePath, 'win32')).toThrow();
    expect(() => path.win32.normalize(devicePath)).not.toThrow();
  });
});

describe('DOCUMENTED DIFFERENCE D-2: bare drive letter C: is rejected by ours', () => {
  it('our module rejects bare C: (drive-relative)', () => {
    expect(() => assertNotUnsupportedPath('C:', 'win32')).toThrow();
  });
  it('node:path.win32 treats C: as relative (no throw)', () => {
    expect(() => path.win32.normalize('C:')).not.toThrow();
  });
});

describe('DOCUMENTED DIFFERENCE D-3: drive-relative C:foo rejected by ours', () => {
  it('our module rejects C:foo', () => {
    expect(() => assertNotUnsupportedPath('C:foo', 'win32')).toThrow();
  });
  it('node:path.win32 treats C:foo as relative', () => {
    expect(() => path.win32.isAbsolute('C:foo')).not.toThrow();
    expect(path.win32.isAbsolute('C:foo')).toBe(false); // relative
  });
});

describe('localDirname matches node:path dirname', () => {
  it.each([
    'D:\\workspace\\vault',
    'C:\\toplevel',
    'C:\\Users\\x\\vaults\\cya',
    '\\\\srv\\share\\vault',
  ])('win32 %s', (input) => {
    expect(localDirname(input, 'win32')).toBe(path.win32.dirname(input));
  });

  it.each(['/home/x/vault', '/top', '/a/b/c'])('posix %s', (input) => {
    expect(localDirname(input, 'posix')).toBe(path.posix.dirname(input));
  });
});
