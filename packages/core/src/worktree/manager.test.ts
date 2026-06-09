import { describe, expect, it } from 'vitest';
import { FakeProcess, type ProcessHandler } from '../testing/fake-process.js';
import { WorktreeError, WorktreeManager } from './manager.js';

const PORCELAIN = `worktree /repo
HEAD aaa
branch refs/heads/main

worktree /repo/.chamba/worktrees/test/w1
HEAD bbb
branch refs/heads/chamba/2026-06-09-test/w1
`;

const gitHandler: ProcessHandler = (_cmd, args) => {
  if (args[0] === 'worktree' && args[1] === 'list') return { stdout: PORCELAIN, exitCode: 0 };
  return { exitCode: 0 };
};

describe('WorktreeManager.create', () => {
  it('runs `git worktree add -b <branch> <path>` and returns a handle', async () => {
    const fp = new FakeProcess(() => ({ exitCode: 0 }));
    const handle = await new WorktreeManager(fp).create({
      root: '/repo',
      taskSlug: 'My Task',
      workerId: 'implementer',
      date: '2026-06-09',
    });

    expect(handle.branch).toBe('chamba/2026-06-09-my-task/implementer');
    expect(handle.path).toBe('/repo/.chamba/worktrees/my-task/implementer');
    expect(fp.calls[0]?.args).toEqual([
      'worktree',
      'add',
      '-b',
      'chamba/2026-06-09-my-task/implementer',
      '/repo/.chamba/worktrees/my-task/implementer',
    ]);
  });

  it('appends the base branch when given', async () => {
    const fp = new FakeProcess(() => ({ exitCode: 0 }));
    await new WorktreeManager(fp).create({
      root: '/repo',
      taskSlug: 't',
      workerId: 'w',
      date: '2026-06-09',
      baseBranch: 'main',
    });
    expect(fp.calls[0]?.args.at(-1)).toBe('main');
  });

  it('throws when git fails', async () => {
    const fp = new FakeProcess(() => ({ exitCode: 1, stderr: 'fatal: branch exists' }));
    await expect(
      new WorktreeManager(fp).create({
        root: '/repo',
        taskSlug: 't',
        workerId: 'w',
        date: '2026-06-09',
      }),
    ).rejects.toBeInstanceOf(WorktreeError);
  });
});

describe('WorktreeManager.list', () => {
  it('parses `git worktree list --porcelain`', async () => {
    const fp = new FakeProcess(gitHandler);
    const list = await new WorktreeManager(fp).list('/repo');
    expect(list).toEqual([
      { path: '/repo', head: 'aaa', branch: 'main' },
      {
        path: '/repo/.chamba/worktrees/test/w1',
        head: 'bbb',
        branch: 'chamba/2026-06-09-test/w1',
      },
    ]);
  });
});

describe('WorktreeManager.cleanup', () => {
  it('removes the worktree without --force and KEEPS the branch', async () => {
    const fp = new FakeProcess(gitHandler);
    const result = await new WorktreeManager(fp).cleanup('/repo', 'chamba/2026-06-09-test/w1');

    expect(result).toEqual({
      removed: true,
      branchKept: true,
      mergeSuggestion: 'git merge --no-ff chamba/2026-06-09-test/w1',
    });

    const removeCall = fp.calls.find((c) => c.args[0] === 'worktree' && c.args[1] === 'remove');
    expect(removeCall?.args).toEqual(['worktree', 'remove', '/repo/.chamba/worktrees/test/w1']);

    // NEVER --force, NEVER delete the branch, NEVER merge.
    const dangerous = fp.calls.filter(
      (c) =>
        c.args.includes('--force') ||
        c.args[0] === 'merge' ||
        c.args.includes('-D') ||
        c.args.includes('-d'),
    );
    expect(dangerous).toEqual([]);
  });

  it('fails loudly when the worktree is dirty (remove exits non-zero)', async () => {
    const fp = new FakeProcess((_cmd, args) => {
      if (args[0] === 'worktree' && args[1] === 'list') return { stdout: PORCELAIN, exitCode: 0 };
      if (args[0] === 'worktree' && args[1] === 'remove') {
        return { exitCode: 1, stderr: 'contains modified or untracked files' };
      }
      return { exitCode: 0 };
    });

    await expect(
      new WorktreeManager(fp).cleanup('/repo', 'chamba/2026-06-09-test/w1'),
    ).rejects.toBeInstanceOf(WorktreeError);

    // It must not retry with --force.
    expect(fp.calls.some((c) => c.args.includes('--force'))).toBe(false);
  });

  it('throws when no worktree matches the branch', async () => {
    const fp = new FakeProcess(gitHandler);
    await expect(new WorktreeManager(fp).cleanup('/repo', 'chamba/unknown')).rejects.toBeInstanceOf(
      WorktreeError,
    );
  });
});
