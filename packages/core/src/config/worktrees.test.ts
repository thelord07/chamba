import { describe, expect, it } from 'vitest';
import { parseChambaConfig } from './schema.js';
import { DEFAULT_WORKTREE_CONFIG, resolveWorktreeConfig } from './worktrees.js';

describe('resolveWorktreeConfig', () => {
  it('returns the compiled defaults when nothing is provided', () => {
    expect(resolveWorktreeConfig()).toEqual(DEFAULT_WORKTREE_CONFIG);
    expect(resolveWorktreeConfig().root).toBe('WORKTREES');
    expect(resolveWorktreeConfig().layout).toBe('sibling');
  });

  it('merges a partial config per field', () => {
    const resolved = resolveWorktreeConfig({ root: 'wt', copyEnvFiles: true });
    expect(resolved.root).toBe('wt');
    expect(resolved.copyEnvFiles).toBe(true);
    // untouched fields keep defaults
    expect(resolved.branchPrefix).toBe('chamba/');
    expect(resolved.layout).toBe('sibling');
  });
});

describe('worktrees schema (via parseChambaConfig)', () => {
  it('accepts a valid worktrees block', () => {
    const result = parseChambaConfig({
      version: 1,
      worktrees: {
        layout: 'sibling',
        root: 'WORKTREES',
        branchPrefix: 'ticket/',
        copyEnvFiles: true,
        editorWorkspace: 'code-workspace',
        repos: ['api', 'web'],
      },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts a command escape hatch', () => {
    const result = parseChambaConfig({
      version: 1,
      worktrees: { command: './ticket-create.sh {ticket} {repos}' },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a bad layout', () => {
    const result = parseChambaConfig({ version: 1, worktrees: { layout: 'flat' } });
    expect(result.ok).toBe(false);
  });

  it('rejects a traversal in root', () => {
    const result = parseChambaConfig({ version: 1, worktrees: { root: '../escape' } });
    expect(result.ok).toBe(false);
  });

  it('rejects unknown keys in worktrees', () => {
    const result = parseChambaConfig({ version: 1, worktrees: { nope: true } });
    expect(result.ok).toBe(false);
  });
});
