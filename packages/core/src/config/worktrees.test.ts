import { describe, expect, it } from 'vitest';
import { parseChambaConfig } from './schema.js';
import {
  DEFAULT_WORKTREE_CONFIG,
  mergeWorktreePartial,
  resolveWorktreeConfig,
} from './worktrees.js';

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

  it('defaults the parallelism knobs to auto (null)', () => {
    const d = resolveWorktreeConfig();
    expect(d.maxParallel).toBeNull();
    expect(d.perWorkerMemMB).toBeNull();
  });

  it('defaults ports off and overlap as warn-only', () => {
    const d = resolveWorktreeConfig();
    expect(d.ports).toEqual({ enabled: false, base: 3000, step: 10, envKey: 'PORT' });
    expect(d.overlap.failOnOverlap).toBe(false);
  });

  it('merges nested ports fields over defaults', () => {
    const resolved = resolveWorktreeConfig({ ports: { enabled: true, base: 4000 } });
    expect(resolved.ports.enabled).toBe(true);
    expect(resolved.ports.base).toBe(4000);
    expect(resolved.ports.step).toBe(10);
    expect(resolved.ports.envKey).toBe('PORT');
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

  it('accepts maxParallel and perWorkerMemMB', () => {
    const result = parseChambaConfig({
      version: 1,
      worktrees: { maxParallel: 3, perWorkerMemMB: 1536 },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a non-positive maxParallel', () => {
    const result = parseChambaConfig({ version: 1, worktrees: { maxParallel: 0 } });
    expect(result.ok).toBe(false);
  });

  it('accepts ports and overlap blocks', () => {
    const result = parseChambaConfig({
      version: 1,
      worktrees: {
        ports: { enabled: true, base: 4000, step: 10, envKey: 'PORT' },
        overlap: { failOnOverlap: true },
      },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an invalid envKey', () => {
    const result = parseChambaConfig({
      version: 1,
      worktrees: { ports: { envKey: 'not-valid' } },
    });
    expect(result.ok).toBe(false);
  });
});

describe('mergeWorktreePartial', () => {
  it('deep-merges ports so a later layer can set only base', () => {
    const merged = mergeWorktreePartial(
      { ports: { enabled: true, base: 3000 } },
      { ports: { base: 4000 } },
    );
    expect(merged.ports).toMatchObject({ enabled: true, base: 4000 });
  });
});
