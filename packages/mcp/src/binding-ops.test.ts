/**
 * binding-ops.test.ts — PARCHE-010 unit tests for parche/binding-ops.ts.
 *
 * Covers:
 *   - checkAdoptionGate: pure function behavior
 *   - gateStructuredDetails: structured content keys
 *   - resolveJoinScope: no workspace, in workspace, explicit scope, invalid scope
 *   - formatSyncOutput: exact field mapping, truncation at 50 for conflicts and movedToTrash
 *   - redactSecrets: replaces pch_ tokens
 */

import { FakeHash, FakeParche, MemoryFilesystem } from '@chamba/core';
import { describe, expect, it } from 'vitest';
import {
  checkAdoptionGate,
  formatSyncOutput,
  gateStructuredDetails,
  redactSecrets,
  resolveJoinScope,
} from './parche/binding-ops.js';
import type { Services } from './services.js';

const FAKE_NOW = '2026-06-09T10:00:00.000Z';
const HOMEDIR = '/home/test';
const WORKSPACE = `${HOMEDIR}/Projects/my-workspace`;

function makeClock(now = FAKE_NOW) {
  const d = new Date(now);
  return { now: () => d, today: () => d.toISOString().slice(0, 10) };
}

function makeParche() {
  const parche = new FakeParche(makeClock());
  return parche;
}

function makeServices(extra: Partial<Services> = {}): Services {
  return {
    fs: new MemoryFilesystem(),
    process: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    clock: makeClock(),
    system: {
      resources: () => ({
        totalMemBytes: 16 * 1024 ** 3,
        freeMemBytes: 8 * 1024 ** 3,
        cpus: 8,
        loadAvg1: 0,
      }),
    },
    cwd: '/proj',
    homedir: HOMEDIR,
    http: makeParche(),
    hash: new FakeHash(),
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
    ...extra,
  };
}

async function makeWorkspaceServices(extra: Partial<Services> = {}): Promise<Services> {
  const fs = new MemoryFilesystem();
  // Create workspace marker
  await fs.mkdir(`${WORKSPACE}/.chamba`);
  await fs.writeFile(`${WORKSPACE}/.chamba/workspace.md`, '# Workspace\n');
  return makeServices({ fs, cwd: WORKSPACE, ...extra });
}

// ─── checkAdoptionGate ───────────────────────────────────────────────────────

describe('checkAdoptionGate', () => {
  it('returns proceed when syncableCount is 0 (empty vault)', () => {
    const result = checkAdoptionGate({ syncableCount: 0, ignoredCount: 0, sample: [] });
    expect(result.kind).toBe('proceed');
  });

  it('returns proceed when confirmUpload is true', () => {
    const result = checkAdoptionGate(
      { syncableCount: 5, ignoredCount: 2, sample: ['a.md', 'b.md'] },
      true,
    );
    expect(result.kind).toBe('proceed');
  });

  it('returns needs-confirmation when syncableCount > 0 and no confirmUpload', () => {
    const result = checkAdoptionGate({
      syncableCount: 3,
      ignoredCount: 1,
      sample: ['a.md', 'b.md', 'c.md'],
    });
    expect(result.kind).toBe('needs-confirmation');
    if (result.kind === 'needs-confirmation') {
      expect(result.fileCount).toBe(3);
      expect(result.ignoredCount).toBe(1);
      expect(result.sample).toEqual(['a.md', 'b.md', 'c.md']);
    }
  });

  it('returns needs-confirmation when confirmUpload is false', () => {
    const result = checkAdoptionGate({ syncableCount: 3, ignoredCount: 0, sample: [] }, false);
    expect(result.kind).toBe('needs-confirmation');
  });
});

// ─── gateStructuredDetails ────────────────────────────────────────────────────

describe('gateStructuredDetails', () => {
  it('returns syncableCount and sample for needs-confirmation', () => {
    const gate = checkAdoptionGate({ syncableCount: 5, ignoredCount: 2, sample: ['a.md'] });
    const details = gateStructuredDetails(gate);
    expect(details.syncableCount).toBe(5);
    expect(details.ignoredCount).toBe(2);
    expect(details.sample).toEqual(['a.md']);
  });

  it('returns zeros for proceed gate', () => {
    const gate = checkAdoptionGate({ syncableCount: 0, ignoredCount: 0, sample: [] });
    const details = gateStructuredDetails(gate);
    expect(details.syncableCount).toBe(0);
    expect(details.ignoredCount).toBe(0);
    expect(details.sample).toEqual([]);
  });
});

// ─── resolveJoinScope ─────────────────────────────────────────────────────────

describe('resolveJoinScope', () => {
  it('returns global when not in a workspace and no scope flag', async () => {
    const svc = makeServices({ cwd: '/proj' });
    const result = await resolveJoinScope(svc);
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.scope).toBe('global');
      expect(result.wsRoot).toBeNull();
    }
  });

  it('returns needs-scope when inside a workspace and no scope flag', async () => {
    const svc = await makeWorkspaceServices();
    const result = await resolveJoinScope(svc);
    expect(result.kind).toBe('needs-scope');
    if (result.kind === 'needs-scope') {
      expect(result.wsRoot).toBe(WORKSPACE);
    }
  });

  it('returns resolved workspace scope when scopeFlag="workspace" in a workspace', async () => {
    const svc = await makeWorkspaceServices();
    const result = await resolveJoinScope(svc, 'workspace');
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.scope).toBe('workspace');
      expect(result.wsRoot).toBe(WORKSPACE);
    }
  });

  it('returns resolved global scope when scopeFlag="global"', async () => {
    const svc = await makeWorkspaceServices();
    const result = await resolveJoinScope(svc, 'global');
    expect(result.kind).toBe('resolved');
    if (result.kind === 'resolved') {
      expect(result.scope).toBe('global');
    }
  });

  it('returns error for invalid scope flag', async () => {
    const svc = makeServices();
    const result = await resolveJoinScope(svc, 'invalid-scope');
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('invalid-scope');
    }
  });

  it('returns error when scopeFlag=workspace but no workspace detected', async () => {
    const svc = makeServices({ cwd: '/some/dir-without-workspace' });
    const result = await resolveJoinScope(svc, 'workspace');
    expect(result.kind).toBe('error');
  });

  it('uses services.workspaceRoot when set (env override)', async () => {
    const svc = makeServices({ workspaceRoot: WORKSPACE });
    const result = await resolveJoinScope(svc);
    // workspaceRoot is set → needs-scope
    expect(result.kind).toBe('needs-scope');
    if (result.kind === 'needs-scope') {
      expect(result.wsRoot).toBe(WORKSPACE);
    }
  });
});

// ─── formatSyncOutput ─────────────────────────────────────────────────────────

describe('formatSyncOutput', () => {
  it('maps pushed, pulled, conflicts, movedToTrash, errors exactly', () => {
    const summary = {
      pushed: 3,
      pulled: 5,
      conflicts: [{ path: 'note.md', copyPath: 'note (conflicto Joys).md' }],
      movedToTrash: ['deleted.md'],
      movedToTrashEntries: [{ path: 'deleted.md', trashPath: '.chamba-sync/trash/deleted.md' }],
      errors: ['some error'],
    };

    const out = formatSyncOutput(summary);
    expect(out.pushed).toBe(3);
    expect(out.pulled).toBe(5);
    expect(out.conflicts).toHaveLength(1);
    expect(out.conflicts[0]).toEqual({ path: 'note.md', copyPath: 'note (conflicto Joys).md' });
    expect(out.movedToTrash).toHaveLength(1);
    expect(out.movedToTrash[0]).toEqual({
      path: 'deleted.md',
      trashPath: '.chamba-sync/trash/deleted.md',
    });
    expect(out.errors).toEqual(['some error']);
    expect(out.truncated).toBeUndefined();
  });

  it('caps conflicts at 50 and adds truncated.conflicts count', () => {
    const conflicts = Array.from({ length: 51 }, (_, i) => ({
      path: `note${i}.md`,
      copyPath: `note${i} (conflicto Joys).md`,
    }));

    const summary = {
      pushed: 0,
      pulled: 0,
      conflicts,
      movedToTrash: [],
      movedToTrashEntries: [],
      errors: [],
    };

    const out = formatSyncOutput(summary);
    expect(out.conflicts).toHaveLength(50);
    expect(out.truncated).toEqual({ conflicts: 1, movedToTrash: 0 });
  });

  it('caps movedToTrash at 50 and adds truncated.movedToTrash count', () => {
    const movedToTrashEntries = Array.from({ length: 52 }, (_, i) => ({
      path: `deleted${i}.md`,
      trashPath: `.chamba-sync/trash/deleted${i}.md`,
    }));

    const summary = {
      pushed: 0,
      pulled: 0,
      conflicts: [],
      movedToTrash: movedToTrashEntries.map((e) => e.path),
      movedToTrashEntries,
      errors: [],
    };

    const out = formatSyncOutput(summary);
    expect(out.movedToTrash).toHaveLength(50);
    expect(out.truncated).toEqual({ conflicts: 0, movedToTrash: 2 });
  });

  it('exactly 2 conflicts + 1 movedToTrash → no truncated field', () => {
    const summary = {
      pushed: 1,
      pulled: 2,
      conflicts: [
        { path: 'a.md', copyPath: 'a (conflicto Joys).md' },
        { path: 'b.md', copyPath: 'b (conflicto Joys).md' },
      ],
      movedToTrash: ['c.md'],
      movedToTrashEntries: [{ path: 'c.md', trashPath: '.chamba-sync/trash/c.md' }],
      errors: [],
    };

    const out = formatSyncOutput(summary);
    expect(out.conflicts).toHaveLength(2);
    expect(out.movedToTrash).toHaveLength(1);
    expect(out.truncated).toBeUndefined();
    // No movedToTrashEntries key exposed directly
    expect(out).not.toHaveProperty('movedToTrashEntries');
  });
});

// ─── redactSecrets ────────────────────────────────────────────────────────────

describe('redactSecrets', () => {
  it('replaces pch_ tokens', () => {
    const result = redactSecrets('Bearer pch_live_abc123xyz');
    expect(result).not.toContain('pch_');
    expect(result).toContain('<token redactado>');
  });

  it('replaces multiple pch_ tokens in one string', () => {
    const result = redactSecrets('pch_live_abc123 and pch_test_xyz456');
    expect(result).not.toContain('pch_');
  });

  it('does not modify strings without pch_', () => {
    const input = 'some normal text without tokens';
    expect(redactSecrets(input)).toBe(input);
  });

  it('handles pch_live_abc123 (exact R1 test case)', () => {
    const result = redactSecrets('{"error":"pch_live_abc123 not valid"}');
    expect(result).not.toContain('pch_');
  });
});
