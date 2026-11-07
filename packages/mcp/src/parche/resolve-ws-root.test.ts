/**
 * resolve-ws-root.test.ts — CHAMBA-020
 *
 * Tests for the shared workspace-root resolution helper.
 * Tool and CLI must use the same resolution order.
 */

import { FakeHash, FakeParche, MemoryFilesystem } from '@chamba/core';
import { describe, expect, it } from 'vitest';
import type { Services } from '../services.js';
import { resolveWsRoot } from './resolve-ws-root.js';

function makeServices(overrides: Partial<Services> = {}): Services {
  return {
    fs: new MemoryFilesystem({}),
    process: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    clock: { now: () => new Date(), today: () => '2026-01-01' },
    system: {
      resources: () => ({
        totalMemBytes: 8 * 1024 ** 3,
        freeMemBytes: 4 * 1024 ** 3,
        cpus: 4,
        loadAvg1: 0,
      }),
    },
    http: new FakeParche({ now: () => new Date(), today: () => '2026-01-01' }),
    hash: new FakeHash(),
    cwd: '/proj',
    homedir: '/home/test',
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
    metricsMutex: new Map(),
    metricsSessionId: 'test-session',
    navReadBodyCount: 0,
    platform: 'linux',
    username: 'testuser',
    ...overrides,
  };
}

describe('resolveWsRoot', () => {
  it('returns workspaceRoot when explicitly set', async () => {
    const services = makeServices({ workspaceRoot: '/explicit/ws' });
    const result = await resolveWsRoot(services);
    expect(result).toBe('/explicit/ws');
  });

  it('returns cwd as fallback when no workspace marker found', async () => {
    const services = makeServices({ cwd: '/some/dir' });
    const result = await resolveWsRoot(services);
    expect(result).toBe('/some/dir');
  });

  it('finds workspace root via workspace.md marker', async () => {
    const fs = new MemoryFilesystem({
      '/workspace/.chamba/workspace.md': '# workspace\n',
      '/workspace/project/src/file.ts': 'code',
    });
    const services = makeServices({ fs, cwd: '/workspace/project/src' });
    const result = await resolveWsRoot(services);
    expect(result).toBe('/workspace');
  });

  it('workspaceRoot takes priority over workspace marker', async () => {
    const fs = new MemoryFilesystem({
      '/workspace/.chamba/workspace.md': '# workspace\n',
    });
    const services = makeServices({
      fs,
      cwd: '/workspace/project',
      workspaceRoot: '/explicit/override',
    });
    const result = await resolveWsRoot(services);
    expect(result).toBe('/explicit/override');
  });
});
