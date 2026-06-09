import { describe, expect, it } from 'vitest';
import { diffLines, textsEqual } from './diff.js';

describe('diffLines', () => {
  it('marks removed and added lines', () => {
    const out = diffLines('a\nb\nc', 'a\nx\nc');
    expect(out).toContain('- b');
    expect(out).toContain('+ x');
    expect(out).toContain('  a');
    expect(out).toContain('  c');
  });

  it('returns only context lines for identical input', () => {
    const out = diffLines('a\nb', 'a\nb');
    expect(out).not.toMatch(/^[-+]/m);
  });
});

describe('textsEqual', () => {
  it('compares line-for-line', () => {
    expect(textsEqual('a\nb', 'a\nb')).toBe(true);
    expect(textsEqual('a\nb', 'a\nc')).toBe(false);
  });
});
