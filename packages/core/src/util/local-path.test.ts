/**
 * local-path.test.ts — S14: Unit tests for local-path helpers.
 * Covers isAbsoluteLocal, normalizeLocal, localDirname, localBasename,
 * caseFoldLocal, localRelative, isInvalidPath, assertNotUnsupportedPath.
 *
 * Tests run on ANY OS (style is injectable — 'win32' or 'posix').
 * CHAMBA-015 Test 1.
 */

import { describe, expect, it } from 'vitest';
import {
  assertNotUnsupportedPath,
  caseFoldLocal,
  isAbsoluteLocal,
  isInvalidPath,
  isUnderLocal,
  joinLocal,
  localBasename,
  localDirname,
  localRelative,
  normalizeLocal,
  toAbsoluteLocal,
} from './local-path.js';

// ─── isAbsoluteLocal ─────────────────────────────────────────────────────────

describe('isAbsoluteLocal — win32', () => {
  const tbl: Array<[string, boolean]> = [
    ['D:\\workspace\\vault', true],
    ['d:/workspace/vault', true],
    ['C:\\Users\\x\\vaults\\cya', true],
    ['\\\\srv\\share\\vault', true],
    ['//srv/share/vault', true],
    ['/foo', true], // POSIX-style absolute on Windows
    ['vault', false],
    ['.\\vault', false],
    ['..\\otra\\vault', false],
  ];
  it.each(tbl)('isAbsoluteLocal(%s, win32) → %s', (path, expected) => {
    expect(isAbsoluteLocal(path, 'win32')).toBe(expected);
  });
});

describe('isAbsoluteLocal — posix', () => {
  const tbl: Array<[string, boolean]> = [
    ['/home/user/vault', true],
    ['vault', false],
    ['./vault', false],
    ['../other/vault', false],
    ['a:b', false], // on posix this is relative, not absolute
  ];
  it.each(tbl)('isAbsoluteLocal(%s, posix) → %s', (path, expected) => {
    expect(isAbsoluteLocal(path, 'posix')).toBe(expected);
  });
});

// ─── assertNotUnsupportedPath — rejections on win32 ──────────────────────────

describe('assertNotUnsupportedPath — win32 rejections', () => {
  it('rejects C:foo (drive-relative)', () => {
    expect(() => assertNotUnsupportedPath('C:foo', 'win32')).toThrow();
  });

  it('rejects bare C: (no separator)', () => {
    expect(() => assertNotUnsupportedPath('C:', 'win32')).toThrow();
  });

  it('rejects \\\\?\\C:\\x (device path \\\\?\\ prefix)', () => {
    expect(() => assertNotUnsupportedPath('\\\\?\\C:\\x', 'win32')).toThrow();
  });

  it('rejects \\\\.\\x (device path \\\\.\\ prefix)', () => {
    expect(() => assertNotUnsupportedPath('\\\\.\\x', 'win32')).toThrow();
  });

  it('rejects //./x (device path with forward slashes)', () => {
    expect(() => assertNotUnsupportedPath('//./x', 'win32')).toThrow();
  });

  it('rejects //?/C:/x (device path with forward slashes)', () => {
    expect(() => assertNotUnsupportedPath('//?/C:/x', 'win32')).toThrow();
  });
});

describe('assertNotUnsupportedPath — posix accepts a:b', () => {
  it('a:b is valid on posix (relative dir name)', () => {
    expect(() => assertNotUnsupportedPath('a:b', 'posix')).not.toThrow();
  });

  it('C:foo is valid on posix', () => {
    expect(() => assertNotUnsupportedPath('C:foo', 'posix')).not.toThrow();
  });
});

// ─── normalizeLocal ──────────────────────────────────────────────────────────

describe('normalizeLocal — win32', () => {
  const tbl: Array<[string, string]> = [
    ['D:\\workspace\\vault', 'D:\\workspace\\vault'],
    ['d:/workspace/vault', 'd:\\workspace\\vault'],
    ['C:\\Users\\x\\vaults\\cya', 'C:\\Users\\x\\vaults\\cya'],
    ['\\\\srv\\share\\vault', '\\\\srv\\share\\vault'],
    // Trailing slash removal
    ['D:\\workspace\\vault\\', 'D:\\workspace\\vault'],
    // Mixed separators
    ['D:/a\\b', 'D:\\a\\b'],
    // Dot resolution
    ['D:\\workspace\\.\\vault', 'D:\\workspace\\vault'],
    ['D:\\workspace\\sub\\..\\vault', 'D:\\workspace\\vault'],
    // Cannot escape root
    ['C:\\..', 'C:'],
    ['C:\\a\\..\\..', 'C:'],
  ];
  it.each(tbl)('normalizeLocal(%s, win32) → %s', (input, expected) => {
    expect(normalizeLocal(input, 'win32')).toBe(expected);
  });
});

describe('normalizeLocal — posix', () => {
  const tbl: Array<[string, string]> = [
    ['/home/user/vault', '/home/user/vault'],
    ['/home/user/vault/', '/home/user/vault'],
    ['/home/./vault', '/home/vault'],
    ['/home/user/../vault', '/home/vault'],
    // Cannot escape root
    ['/../..', '/'],
  ];
  it.each(tbl)('normalizeLocal(%s, posix) → %s', (input, expected) => {
    expect(normalizeLocal(input, 'posix')).toBe(expected);
  });
});

// ─── localDirname ─────────────────────────────────────────────────────────────

describe('localDirname — win32', () => {
  const tbl: Array<[string, string]> = [
    ['D:\\workspace\\vault', 'D:\\workspace'],
    ['C:\\Users\\x\\vaults\\cya', 'C:\\Users\\x\\vaults'],
    ['C:\\toplevel', 'C:\\'],
    ['\\\\srv\\share\\vault', '\\\\srv\\share\\'],
  ];
  it.each(tbl)('localDirname(%s, win32) → %s', (input, expected) => {
    expect(localDirname(input, 'win32')).toBe(expected);
  });
});

describe('localDirname — posix', () => {
  const tbl: Array<[string, string]> = [
    ['/home/user/vault', '/home/user'],
    ['/home/user', '/home'],
    ['/toplevel', '/'],
    ['vault/sub', 'vault'],
    ['vault', '.'],
  ];
  it.each(tbl)('localDirname(%s, posix) → %s', (input, expected) => {
    expect(localDirname(input, 'posix')).toBe(expected);
  });
});

// ─── localBasename ────────────────────────────────────────────────────────────

describe('localBasename — win32', () => {
  it('returns last segment for D:\\workspace\\vault', () => {
    expect(localBasename('D:\\workspace\\vault', 'win32')).toBe('vault');
  });

  it('strips trailing separator', () => {
    expect(localBasename('D:\\workspace\\vault\\', 'win32')).toBe('vault');
  });
});

// ─── caseFoldLocal ────────────────────────────────────────────────────────────

describe('caseFoldLocal', () => {
  it('lowercases and normalizes separators on win32', () => {
    expect(caseFoldLocal('D:\\Workspace\\Vault', 'win32')).toBe('d:/workspace/vault');
    expect(caseFoldLocal('C:\\Users\\X', 'win32')).toBe('c:/users/x');
  });

  it('returns unchanged on posix', () => {
    expect(caseFoldLocal('/Home/User/Vault', 'posix')).toBe('/Home/User/Vault');
  });

  it('d: and D: fold to same value on win32', () => {
    expect(caseFoldLocal('d:\\foo', 'win32')).toBe(caseFoldLocal('D:\\foo', 'win32'));
  });
});

// ─── localRelative ────────────────────────────────────────────────────────────

describe('localRelative', () => {
  it('computes relative path on posix', () => {
    expect(localRelative('/workspace', '/workspace/vault/sub', 'posix')).toBe('vault/sub');
  });

  it('computes relative path on win32 (case-insensitive)', () => {
    expect(localRelative('D:\\Workspace', 'D:\\workspace\\vault', 'win32')).toBe('vault');
  });

  it('returns . when target equals base (win32)', () => {
    expect(localRelative('D:\\workspace', 'D:\\workspace', 'win32')).toBe('.');
  });

  it('returns target unchanged when not under base', () => {
    expect(localRelative('/a', '/b/c', 'posix')).toBe('/b/c');
  });
});

// ─── toAbsoluteLocal ─────────────────────────────────────────────────────────

describe('toAbsoluteLocal', () => {
  it('leaves absolute paths unchanged (posix)', () => {
    expect(toAbsoluteLocal('/cwd', '/abs/path', 'posix')).toBe('/abs/path');
  });

  it('resolves relative paths against cwd (posix)', () => {
    expect(toAbsoluteLocal('/cwd', 'vault', 'posix')).toBe('/cwd/vault');
  });

  it('resolves .\\vault against cwd on win32', () => {
    const result = toAbsoluteLocal('D:\\ws', '.\\vault', 'win32');
    expect(result).toContain('vault');
  });

  it('leaves absolute win32 path unchanged', () => {
    expect(toAbsoluteLocal('D:\\ws', 'D:\\other\\vault', 'win32')).toBe('D:\\other\\vault');
  });
});

// ─── joinLocal ────────────────────────────────────────────────────────────────

describe('joinLocal', () => {
  it('joins paths with /', () => {
    expect(joinLocal('/home', 'user', 'vault')).toBe('/home/user/vault');
  });

  it('does not duplicate separators', () => {
    expect(joinLocal('/home/', 'vault')).toBe('/home/vault');
  });

  // CHAMBA-015 fix: UNC leading \\ must not be collapsed to /
  it('preserves leading \\\\ of a UNC base (win32)', () => {
    expect(joinLocal('\\\\srv\\share', 'sub')).toBe('\\\\srv\\share/sub');
  });

  it('preserves leading // of a POSIX-UNC-style base', () => {
    expect(joinLocal('//srv/share', 'sub')).toBe('//srv/share/sub');
  });

  it('still collapses internal duplicate separators', () => {
    expect(joinLocal('/home', '//sub//dir')).toBe('/home/sub/dir');
  });
});

// ─── toAbsoluteLocal UNC ──────────────────────────────────────────────────────

describe('toAbsoluteLocal — UNC cwd', () => {
  it('resolves a relative path against a UNC cwd without collapsing the prefix', () => {
    // CHAMBA-015 fix: \\srv\share as cwd + relative path must not lose UNC \\
    expect(toAbsoluteLocal('\\\\srv\\share\\work', 'vault', 'win32')).toBe(
      '\\\\srv\\share\\work/vault',
    );
  });
});

// ─── isInvalidPath ────────────────────────────────────────────────────────────

describe('isInvalidPath — win32', () => {
  // From D1.2 ticket table
  const invalidCases: Array<[string, string]> = [
    ['CON.md', 'reserved name CON'],
    ['a/CON.md', 'reserved name CON'],
    ['dir/CON/x.md', 'reserved name CON in dir component'],
    ['a:b.md', 'colon in name'],
    ['con.txt.md', 'stem "con" reserved regardless of extension'],
    ['a/con.txt.md', 'stem "con" reserved in subdir'],
    ['x /y.md', 'trailing space in component'],
    ['y./z.md', 'trailing dot in component'],
    ['file<bad.md', 'forbidden char <'],
    ['file>bad.md', 'forbidden char >'],
    ['file"bad.md', 'forbidden char "'],
    ['file|bad.md', 'forbidden char |'],
    ['file?bad.md', 'forbidden char ?'],
    ['file*bad.md', 'forbidden char *'],
    ['PRN.md', 'reserved name PRN'],
    ['AUX.md', 'reserved name AUX'],
    ['NUL.md', 'reserved name NUL'],
    ['COM1.md', 'reserved name COM1'],
    ['LPT9.txt', 'reserved name LPT9'],
    ['nul.md', 'reserved name nul (case-insensitive)'],
    ['Nul.txt', 'reserved name Nul (case-insensitive)'],
  ];

  it.each(invalidCases)('%s → invalid (%s)', (path) => {
    expect(isInvalidPath(path, 'win32')).toBe(true);
  });

  const validCases: Array<[string, string]> = [
    ['a/b.md', 'normal path'],
    ['note.md', 'simple name'],
    ['sub/CONTAIN.md', 'starts with reserved but longer'],
    ['sub/console.md', 'starts with CON but longer'],
    ['LPT10.md', 'LPT10 is NOT reserved (only 1-9)'],
    ['COM0.md', 'COM0 is NOT reserved'],
  ];

  it.each(validCases)('%s → valid (%s)', (path) => {
    expect(isInvalidPath(path, 'win32')).toBe(false);
  });
});

describe('isInvalidPath — posix (always false)', () => {
  it('CON.md is valid on posix', () => {
    expect(isInvalidPath('CON.md', 'posix')).toBe(false);
  });

  it('a:b.md is valid on posix', () => {
    expect(isInvalidPath('a:b.md', 'posix')).toBe(false);
  });

  it('NUL is valid on posix', () => {
    expect(isInvalidPath('NUL', 'posix')).toBe(false);
  });
});

describe('isUnderLocal (CHAMBA-022, B5/B7)', () => {
  it('posix: a strict descendant is contained', () => {
    expect(isUnderLocal('/ws', '/ws/repo', 'posix')).toBe(true);
    expect(isUnderLocal('/ws', '/other', 'posix')).toBe(false);
  });

  it('posix: equality is contained by default, rejected when strict', () => {
    expect(isUnderLocal('/ws', '/ws', 'posix')).toBe(true);
    expect(isUnderLocal('/ws', '/ws', 'posix', { strict: true })).toBe(false);
  });

  it('posix: a sibling with a shared prefix is NOT contained (no false positive on "/ws-other")', () => {
    expect(isUnderLocal('/ws', '/ws-other/repo', 'posix')).toBe(false);
  });

  it('win32: case-insensitive and separator-insensitive', () => {
    expect(isUnderLocal('C:\\ws', 'c:/WS/repo', 'win32')).toBe(true);
    expect(isUnderLocal('C:\\ws', 'C:\\ws', 'win32', { strict: true })).toBe(false);
    expect(isUnderLocal('C:\\ws', 'D:\\ws\\repo', 'win32')).toBe(false);
  });
});
