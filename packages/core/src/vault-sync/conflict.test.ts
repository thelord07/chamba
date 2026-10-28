import { describe, expect, it } from 'vitest';
import {
  addConflictFrontmatter,
  conflictCopyPath,
  readConflictMeta,
  sanitizeAuthor,
} from './conflict.js';

describe('sanitizeAuthor', () => {
  it('sanitizes diacritics, lowercases and replaces spaces', () => {
    expect(sanitizeAuthor('Vale')).toBe('vale');
    expect(sanitizeAuthor('María José')).toBe('maria-jose');
    expect(sanitizeAuthor('  --  ')).toBe('anon');
    expect(sanitizeAuthor('')).toBe('anon');
  });

  it('preserves [a-z0-9._-] chars', () => {
    expect(sanitizeAuthor('john.doe_2')).toBe('john.doe_2');
  });
});

describe('conflictCopyPath — AC6', () => {
  it('basic: auth/flujo-login.md, Vale → auth/flujo-login (conflicto vale).md', () => {
    const result = conflictCopyPath('auth/flujo-login.md', 'Vale', new Set());
    expect(result).toBe('auth/flujo-login (conflicto vale).md');
  });

  it('numbering: second attempt yields …(conflicto vale 2).md', () => {
    const existing = new Set(['auth/flujo-login (conflicto vale).md']);
    const result = conflictCopyPath('auth/flujo-login.md', 'Vale', existing);
    expect(result).toBe('auth/flujo-login (conflicto vale 2).md');
  });

  it('skips to 3 if 2 also taken', () => {
    const existing = new Set([
      'auth/flujo-login (conflicto vale).md',
      'auth/flujo-login (conflicto vale 2).md',
    ]);
    const result = conflictCopyPath('auth/flujo-login.md', 'Vale', existing);
    expect(result).toBe('auth/flujo-login (conflicto vale 3).md');
  });

  it('img/a.png → img/a (conflicto vale).png', () => {
    const result = conflictCopyPath('img/a.png', 'Vale', new Set());
    expect(result).toBe('img/a (conflicto vale).png');
  });

  it('root-level file (no dir)', () => {
    const result = conflictCopyPath('readme.md', 'Author', new Set());
    expect(result).toBe('readme (conflicto author).md');
  });

  it('dotfile (no extension)', () => {
    const result = conflictCopyPath('.obsidian/app.json', 'dev', new Set());
    // extname('.json') = '.json', basename = 'app.json', stem = 'app'
    expect(result).toBe('.obsidian/app (conflicto dev).json');
  });

  it('nested path', () => {
    const result = conflictCopyPath('a/b/c/file.md', 'x', new Set());
    expect(result).toBe('a/b/c/file (conflicto x).md');
  });

  it('file with no extension', () => {
    const result = conflictCopyPath('notes/README', 'bob', new Set());
    expect(result).toBe('notes/README (conflicto bob)');
  });
});

describe('addConflictFrontmatter — AC7', () => {
  const base = '---\ntitle: My Note\ntags: [work]\n---\n# Heading\n\nContent';

  it('preserves existing keys and adds conflict keys', () => {
    const result = addConflictFrontmatter(base, {
      conflictOf: 'auth/flujo-login.md',
      conflictBase: 'a'.repeat(64),
    });
    expect(result).toContain('title: My Note');
    expect(result).toContain('tags: [work]');
    expect(result).toContain('conflict_of: "auth/flujo-login.md"');
    expect(result).toContain(`conflict_base: ${'a'.repeat(64)}`);
  });

  it('creates frontmatter when absent', () => {
    const md = '# No frontmatter\n\nBody text';
    const result = addConflictFrontmatter(md, {
      conflictOf: 'x.md',
      conflictBase: null,
    });
    expect(result.startsWith('---')).toBe(true);
    expect(result).toContain('conflict_of: "x.md"');
    expect(result).toContain('conflict_base: null');
  });

  it('handles conflictBase: null → literal "null"', () => {
    const result = addConflictFrontmatter(base, {
      conflictOf: 'y.md',
      conflictBase: null,
    });
    expect(result).toContain('conflict_base: null');
  });

  it('is idempotent', () => {
    const once = addConflictFrontmatter(base, {
      conflictOf: 'auth/flujo-login.md',
      conflictBase: 'a'.repeat(64),
    });
    const twice = addConflictFrontmatter(once, {
      conflictOf: 'auth/flujo-login.md',
      conflictBase: 'a'.repeat(64),
    });
    expect(twice).toBe(once);
  });

  it('escapes double quotes in conflictOf', () => {
    const result = addConflictFrontmatter('# x', {
      conflictOf: 'path/with "quotes".md',
      conflictBase: null,
    });
    expect(result).toContain('conflict_of: "path/with \\"quotes\\".md"');
  });
});

describe('readConflictMeta — AC7', () => {
  it('reads existing conflict meta', () => {
    const md = addConflictFrontmatter('# x', {
      conflictOf: 'auth/flujo-login.md',
      conflictBase: 'f'.repeat(64),
    });
    const meta = readConflictMeta(md);
    expect(meta).toEqual({
      conflictOf: 'auth/flujo-login.md',
      conflictBase: 'f'.repeat(64),
    });
  });

  it('returns null conflictBase when hash was null', () => {
    const md = addConflictFrontmatter('# x', {
      conflictOf: 'y.md',
      conflictBase: null,
    });
    const meta = readConflictMeta(md);
    expect(meta?.conflictBase).toBeNull();
  });

  it('returns null when no frontmatter', () => {
    expect(readConflictMeta('# plain')).toBeNull();
  });

  it('returns null when frontmatter has no conflict keys', () => {
    const md = '---\ntitle: Normal\n---\n# x';
    expect(readConflictMeta(md)).toBeNull();
  });

  it('returns null when only conflict_base is present (no conflict_of)', () => {
    const md = '---\ntitle: Normal\nconflict_base: null\n---\n# x';
    expect(readConflictMeta(md)).toBeNull();
  });

  it('roundtrip: render → parse is stable', () => {
    const input = {
      conflictOf: 'dir/note with spaces.md',
      conflictBase: 'a'.repeat(64),
    };
    const md = addConflictFrontmatter('# Note', input);
    const meta = readConflictMeta(md);
    const md2 = addConflictFrontmatter(md, input);
    const meta2 = readConflictMeta(md2);
    expect(meta).toEqual(input);
    expect(meta2).toEqual(input);
    expect(md2).toBe(md);
  });
});
