import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_WORKTREE_CONFIG } from '../config/worktrees.js';
import { FakeProcess, type ProcessHandler } from '../testing/fake-process.js';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { WorktreeError } from './manager.js';
import { MultiRepoWorktreeManager } from './multi-repo-manager.js';
import { planWorktrees } from './multi-repo-plan.js';

const config = { ...DEFAULT_WORKTREE_CONFIG, root: 'WORKTREES', branchPrefix: 'ticket/' };

function items(repos: string[]) {
  return planWorktrees({ workspaceRoot: '/ws', ticket: 'T-1', repos, config });
}

function only<T>(arr: T[]): T {
  const [first] = arr;
  if (first === undefined) throw new Error('expected exactly one result');
  return first;
}

function gitHandler(opts: {
  local?: boolean;
  remote?: boolean;
  removeFail?: boolean;
}): ProcessHandler {
  return (_cmd, args) => {
    if (args[0] === 'show-ref') return { exitCode: opts.local ? 0 : 1 };
    if (args[0] === 'ls-remote') return { exitCode: opts.remote ? 0 : 2 };
    if (args[0] === 'worktree' && args[1] === 'remove') {
      return opts.removeFail ? { exitCode: 1, stderr: 'dirty' } : { exitCode: 0 };
    }
    return { exitCode: 0 }; // worktree add, fetch
  };
}

const create = (
  proc: FakeProcess,
  fs: MemoryFilesystem,
  overrides: Partial<Parameters<MultiRepoWorktreeManager['create']>[0]> = {},
) =>
  new MultiRepoWorktreeManager(proc, fs).create({
    items: items(['api']),
    baseBranch: 'main',
    copyEnvFiles: false,
    envPruneDirs: [],
    ...overrides,
  });

describe('MultiRepoWorktreeManager.create', () => {
  let fs: MemoryFilesystem;

  beforeEach(() => {
    fs = new MemoryFilesystem({ '/ws/api/.git/HEAD': 'ref: refs/heads/main\n' });
  });

  it('creates a new branch from origin when none exists', async () => {
    const proc = new FakeProcess(gitHandler({ local: false, remote: false }));
    const res = only(await create(proc, fs));
    expect(res.status).toBe('created');
    expect(res.branch).toBe('ticket/T-1');
    expect(
      proc.calls.some(
        (c) => c.args.join(' ') === 'worktree add -b ticket/T-1 /ws/WORKTREES/T-1/api origin/main',
      ),
    ).toBe(true);
  });

  it('reuses an existing local branch', async () => {
    const proc = new FakeProcess(gitHandler({ local: true }));
    const res = only(await create(proc, fs));
    expect(res.status).toBe('reused-local');
    expect(
      proc.calls.some((c) => c.args.join(' ') === 'worktree add /ws/WORKTREES/T-1/api ticket/T-1'),
    ).toBe(true);
  });

  it('reuses an existing remote branch (fetch + add)', async () => {
    const proc = new FakeProcess(gitHandler({ local: false, remote: true }));
    const res = only(await create(proc, fs));
    expect(res.status).toBe('reused-remote');
    expect(proc.calls.some((c) => c.args.join(' ') === 'fetch origin ticket/T-1:ticket/T-1')).toBe(
      true,
    );
  });

  it('skips when the worktree already exists', async () => {
    fs.writeFile('/ws/WORKTREES/T-1/api/.git', 'gitdir: ...');
    const proc = new FakeProcess(gitHandler({}));
    const res = only(await create(proc, fs));
    expect(res.status).toBe('skipped-exists');
    expect(proc.calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'add')).toBe(false);
  });

  it('skips a repo that is not a git checkout', async () => {
    const noGit = new MemoryFilesystem({ '/ws/api/readme.md': 'x' });
    const proc = new FakeProcess(gitHandler({}));
    const res = only(await create(proc, noGit));
    expect(res.status).toBe('skipped-not-git');
  });

  it('copies env files when enabled', async () => {
    fs.writeFile('/ws/api/.env', 'SECRET=1');
    const proc = new FakeProcess(gitHandler({ local: false, remote: false }));
    const res = only(
      await create(proc, fs, { copyEnvFiles: true, envPruneDirs: ['node_modules'] }),
    );
    expect(res.envCopied).toBe(1);
    expect(await fs.exists('/ws/WORKTREES/T-1/api/.env')).toBe(true);
  });
});

describe('MultiRepoWorktreeManager.cleanup', () => {
  it('removes the worktree without --force and keeps the branch', async () => {
    const fs = new MemoryFilesystem({ '/ws/WORKTREES/T-1/api/.git': 'gitdir: ...' });
    const proc = new FakeProcess(gitHandler({}));
    const res = only(await new MultiRepoWorktreeManager(proc, fs).cleanup(items(['api'])));

    expect(res.removed).toBe(true);
    expect(res.mergeSuggestion).toBe('git -C /ws/api merge --no-ff ticket/T-1');
    const removeCall = proc.calls.find((c) => c.args[1] === 'remove');
    expect(removeCall?.args).toEqual(['worktree', 'remove', '/ws/WORKTREES/T-1/api']);
    expect(removeCall?.args).not.toContain('--force');
  });

  it('throws on a dirty worktree instead of discarding work', async () => {
    const fs = new MemoryFilesystem({ '/ws/WORKTREES/T-1/api/.git': 'gitdir: ...' });
    const proc = new FakeProcess(gitHandler({ removeFail: true }));
    await expect(
      new MultiRepoWorktreeManager(proc, fs).cleanup(items(['api'])),
    ).rejects.toBeInstanceOf(WorktreeError);
  });
});
