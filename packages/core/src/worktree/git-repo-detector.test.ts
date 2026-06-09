import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { detectGitRepos } from './git-repo-detector.js';

describe('detectGitRepos', () => {
  it('lists child dirs with a .git directory, ignoring worktrees and non-repos', async () => {
    const fs = new MemoryFilesystem({
      // real repos: .git is a directory
      '/ws/api/.git/HEAD': 'ref: refs/heads/main\n',
      '/ws/web/.git/HEAD': 'ref: refs/heads/main\n',
      // linked worktree: .git is a file → not a repo root
      '/ws/WORKTREES/T-1/.git': 'gitdir: /ws/api/.git/worktrees/T-1\n',
      // plain folder, no git
      '/ws/docs/readme.md': '# docs\n',
    });
    expect(await detectGitRepos(fs, '/ws')).toEqual(['api', 'web']);
  });

  it('returns [] for a missing root', async () => {
    expect(await detectGitRepos(new MemoryFilesystem({}), '/nope')).toEqual([]);
  });
});
