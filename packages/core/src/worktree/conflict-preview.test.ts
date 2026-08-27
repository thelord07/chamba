import { describe, expect, it } from 'vitest';
import { FakeProcess } from '../testing/fake-process.js';
import { ConflictPreviewer } from './conflict-preview.js';
import { WorktreeInspector } from './inspector.js';

const PORCELAIN = `worktree /repo
HEAD aaa
branch refs/heads/main

worktree /repo/.chamba/worktrees/auth/w1
HEAD bbb
branch refs/heads/chamba/auth
`;

describe('WorktreeInspector', () => {
  it('marks overlapping changed files across worktrees', async () => {
    const fp = new FakeProcess((_cmd, args, opts) => {
      if (args[0] === 'worktree' && args[1] === 'list') return { stdout: PORCELAIN };
      if (args[0] === 'status') {
        const dirty = opts?.cwd?.includes('auth/w1') ? ' M src/auth/login.ts\n' : '';
        return { stdout: dirty };
      }
      if (args[0] === 'rev-list' && args.includes('--left-right')) return { stdout: '0\t1' };
      if (args[0] === 'log') return { stdout: '2026-08-26T10:00:00Z\n' };
      if (args[0] === 'diff' && args.includes('main...HEAD')) {
        return { stdout: opts?.cwd?.includes('auth/w1') ? 'src/auth/login.ts\n' : '' };
      }
      if (args[0] === 'rev-parse') return { exitCode: 1 };
      return {};
    });
    const report = await new WorktreeInspector(fp, {
      now: () => new Date('2026-08-26T12:00:00Z'),
      today: () => '2026-08-26',
    }).inspect('/repo', { baseBranch: 'main' });

    expect(report.worktrees).toHaveLength(2);
    expect(report.worktrees[0]?.primary).toBe(true);
    expect(report.worktrees[1]?.dirty).toBe(true);
    expect(report.worktrees[1]?.changedFiles).toContain('src/auth/login.ts');
    expect(report.overlaps).toEqual([]);
  });
});

describe('ConflictPreviewer', () => {
  it('uses merge-tree --name-only and never runs git merge', async () => {
    const fp = new FakeProcess((_cmd, args) => {
      if (args[0] === 'merge-tree' && args[1] === '--name-only') {
        return { stdout: 'src/auth/login.ts\n', exitCode: 1 };
      }
      return { exitCode: 0 };
    });
    const pair = await new ConflictPreviewer(fp).preview('/repo', 'main', 'chamba/auth');
    expect(pair.files).toEqual(['src/auth/login.ts']);
    expect(pair.mode).toBe('name-only');
    expect(fp.calls.some((c) => c.args[0] === 'merge')).toBe(false);
    expect(fp.calls.some((c) => c.args.includes('--force'))).toBe(false);
  });

  it('falls back to classic merge-tree when --name-only is unknown', async () => {
    const fp = new FakeProcess((_cmd, args) => {
      if (args[0] === 'merge-tree' && args[1] === '--name-only') {
        return { exitCode: 128, stderr: "error: unknown option `name-only'\n" };
      }
      if (args[0] === 'merge-base') return { stdout: 'abc123\n' };
      if (args[0] === 'merge-tree') {
        return {
          stdout:
            'changed in both\n  base 100644 x src/auth/login.ts\n  our 100644 y src/auth/login.ts\n',
        };
      }
      return {};
    });
    const pair = await new ConflictPreviewer(fp).preview('/repo', 'main', 'feat');
    expect(pair.mode).toBe('classic');
    expect(pair.files).toContain('src/auth/login.ts');
  });
});
