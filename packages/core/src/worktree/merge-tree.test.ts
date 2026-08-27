import { describe, expect, it } from 'vitest';
import { parseMergeTreeOutput } from './merge-tree.js';

describe('parseMergeTreeOutput', () => {
  it('parses name-only conflict paths', () => {
    expect(
      parseMergeTreeOutput('src/auth/login.ts\nsrc/auth/middleware.ts\n', 'name-only'),
    ).toEqual(['src/auth/login.ts', 'src/auth/middleware.ts']);
  });

  it('parses classic "changed in both" blocks', () => {
    const stdout = [
      'changed in both',
      '  base 100644 abc src/auth/login.ts',
      '  our 100644 def src/auth/login.ts',
      '  their 100644 ghi src/auth/login.ts',
      '',
      'CONFLICT (content): Merge conflict in src/other.ts',
    ].join('\n');
    expect(parseMergeTreeOutput(stdout, 'classic')).toEqual(['src/auth/login.ts', 'src/other.ts']);
  });
});
