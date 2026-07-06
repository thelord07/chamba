import { describe, expect, it } from 'vitest';
import { FakeProcess, type ProcessHandler } from '../testing/fake-process.js';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { type DoctorInput, renderDoctorReport, runDoctor } from './doctor.js';

const gitOk: ProcessHandler = (cmd, args) => {
  if (cmd !== 'git') return {};
  if (args[0] === '--version') return { stdout: 'git version 2.43.0' };
  if (args[0] === 'rev-parse') return { stdout: 'true\n' };
  if (args[0] === 'worktree') {
    return { stdout: 'worktree /proj\nHEAD abc123\nbranch refs/heads/main\n' };
  }
  return {};
};

function input(over: Partial<DoctorInput> = {}, handler: ProcessHandler = gitOk): DoctorInput {
  return {
    fs: new MemoryFilesystem({
      '/vault/.obsidian/app.json': '{}',
      '/vault/note.md': '# note\n',
      '/proj/.chamba/workspace.md': '# Workspace\n',
    }),
    process: new FakeProcess(handler),
    cwd: '/proj',
    homedir: '/home/test',
    obsidianVaultPath: '/vault',
    obsidianSearchRoots: [],
    nodeVersion: 'v22.3.0',
    ...over,
  };
}

function byId(checks: { id: string }[], id: string) {
  const c = checks.find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c as { id: string; status: string; detail: string; hint?: string };
}

describe('runDoctor', () => {
  it('reports healthy when everything is in place', async () => {
    const report = await runDoctor(input());
    expect(report.healthy).toBe(true);
    expect(report.fail).toBe(0);
    expect(byId(report.checks, 'node').status).toBe('ok');
    expect(byId(report.checks, 'git').status).toBe('ok');
    expect(byId(report.checks, 'git-repo').status).toBe('ok');
    expect(byId(report.checks, 'workspace').status).toBe('ok');
    expect(byId(report.checks, 'config').status).toBe('ok');
    expect(byId(report.checks, 'vault').status).toBe('ok');
    expect(byId(report.checks, 'logs').status).toBe('ok');
    // worktrees check only runs inside a git repo
    expect(byId(report.checks, 'worktrees').detail).toContain('main only');
  });

  it('fails on Node older than 22', async () => {
    const report = await runDoctor(input({ nodeVersion: 'v20.11.0' }));
    expect(byId(report.checks, 'node').status).toBe('fail');
    expect(report.healthy).toBe(false);
  });

  it('warns (not fails) on an unreadable Node version', async () => {
    const report = await runDoctor(input({ nodeVersion: undefined }));
    expect(byId(report.checks, 'node').status).toBe('warn');
  });

  it('fails when git is not on PATH', async () => {
    const noGit: ProcessHandler = (cmd, args) => {
      if (cmd === 'git' && args[0] === '--version') return { exitCode: 127 };
      return gitOk(cmd, args);
    };
    const report = await runDoctor(input({}, noGit));
    expect(byId(report.checks, 'git').status).toBe('fail');
    expect(report.healthy).toBe(false);
  });

  it('warns and skips worktrees outside a git repo', async () => {
    const notRepo: ProcessHandler = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'rev-parse') return { stdout: '', exitCode: 128 };
      return gitOk(cmd, args);
    };
    const report = await runDoctor(input({}, notRepo));
    expect(byId(report.checks, 'git-repo').status).toBe('warn');
    expect(report.checks.find((c) => c.id === 'worktrees')).toBeUndefined();
    expect(report.healthy).toBe(true); // warn does not break healthy
  });

  it('warns when the workspace file and vault are missing', async () => {
    const report = await runDoctor(
      input({ fs: new MemoryFilesystem({}), obsidianVaultPath: undefined }),
    );
    expect(byId(report.checks, 'workspace').status).toBe('warn');
    expect(byId(report.checks, 'vault').status).toBe('warn');
    expect(report.healthy).toBe(true);
  });

  it('warns on an invalid config file', async () => {
    const fs = new MemoryFilesystem({
      '/proj/.chamba/workspace.md': '# Workspace\n',
      '/proj/.chamba/config.json': '{ not valid json',
    });
    const report = await runDoctor(input({ fs }));
    const cfg = byId(report.checks, 'config');
    expect(cfg.status).toBe('warn');
    expect(cfg.detail).toContain('invalid config');
  });

  it('renders a report with icons and a summary footer', async () => {
    const text = renderDoctorReport(await runDoctor(input()));
    expect(text).toContain('chamba doctor');
    expect(text).toMatch(/[✓⚠✗]/u);
    expect(text).toMatch(/\d+ ok · \d+ warn · \d+ fail/u);
  });
});
