import { describe, expect, it } from 'vitest';
import { buildBranchName, slugifyForGit, worktreeRelativePath } from './branch-naming.js';

describe('slugifyForGit', () => {
  it('lowercases and removes git-unsafe characters', () => {
    expect(slugifyForGit('My Task!')).toBe('my-task');
    expect(slugifyForGit('feat: add auth~stuff')).toBe('feat-add-auth-stuff');
    expect(slugifyForGit('...')).toBe('x');
  });
});

describe('buildBranchName', () => {
  it('follows the chamba/<date>-<task>/<worker> convention', () => {
    expect(
      buildBranchName({ date: '2026-06-09', taskSlug: 'Add Health', workerId: 'implementer' }),
    ).toBe('chamba/2026-06-09-add-health/implementer');
  });
});

describe('worktreeRelativePath', () => {
  it('places worktrees under .chamba/worktrees', () => {
    expect(worktreeRelativePath('Add Health', 'w1')).toBe('.chamba/worktrees/add-health/w1');
  });
});
