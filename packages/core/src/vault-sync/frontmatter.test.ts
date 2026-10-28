import { describe, expect, it } from 'vitest';
import { joinFrontmatter, readScalar, splitFrontmatter, upsertScalar } from './frontmatter.js';

describe('splitFrontmatter', () => {
  it('splits a document with frontmatter', () => {
    const md = '---\ntitle: Hello\ntags: [a]\n---\n# Body\n\nContent';
    const { fmLines, body, hasFm } = splitFrontmatter(md);
    expect(hasFm).toBe(true);
    expect(fmLines).toEqual(['title: Hello', 'tags: [a]']);
    expect(body).toBe('# Body\n\nContent');
  });

  it('returns hasFm false when no frontmatter', () => {
    const md = '# Just a heading\n\nContent';
    const { hasFm, fmLines, body } = splitFrontmatter(md);
    expect(hasFm).toBe(false);
    expect(fmLines).toEqual([]);
    expect(body).toBe(md);
  });

  it('handles unclosed frontmatter gracefully', () => {
    const md = '---\ntitle: No close';
    const { hasFm } = splitFrontmatter(md);
    expect(hasFm).toBe(false);
  });

  it('handles empty frontmatter block', () => {
    const md = '---\n---\n# Body';
    const { fmLines, hasFm } = splitFrontmatter(md);
    expect(hasFm).toBe(true);
    expect(fmLines).toEqual([]);
  });
});

describe('upsertScalar', () => {
  it('appends key when not present', () => {
    const lines = ['title: Hello'];
    const result = upsertScalar(lines, 'conflict_of', '"notes/foo.md"');
    expect(result).toContain('conflict_of: "notes/foo.md"');
    expect(result).toContain('title: Hello');
  });

  it('replaces existing key', () => {
    const lines = ['title: Hello', 'conflict_of: "old/path.md"'];
    const result = upsertScalar(lines, 'conflict_of', '"new/path.md"');
    expect(result.filter((l) => l.startsWith('conflict_of:'))).toHaveLength(1);
    expect(result).toContain('conflict_of: "new/path.md"');
  });
});

describe('readScalar', () => {
  it('reads existing key', () => {
    const lines = ['title: Hello', 'conflict_of: "notes/foo.md"'];
    expect(readScalar(lines, 'conflict_of')).toBe('"notes/foo.md"');
  });

  it('returns null for missing key', () => {
    const lines = ['title: Hello'];
    expect(readScalar(lines, 'missing')).toBeNull();
  });
});

describe('joinFrontmatter', () => {
  it('produces valid roundtrip', () => {
    const md = '---\ntitle: Hello\n---\n# Body';
    const { fmLines, body } = splitFrontmatter(md);
    const rejoined = joinFrontmatter(fmLines, body);
    expect(splitFrontmatter(rejoined)).toMatchObject({ fmLines, body });
  });
});
