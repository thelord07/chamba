/**
 * vault-config.test.ts — CHAMBA-022 (O1 — owner decision)
 *
 * `resolveSyncEvidenceFlag` reads `vault.syncEvidence` from the SAME two
 * config layers `chamba_task verify` reads (B9): never the worktree's own
 * config. Default is `false` (evidence images excluded from sync).
 */

import { FakeHash, FakeParche, FakeRandom, MemoryFilesystem } from '@chamba/core';
import { describe, expect, it } from 'vitest';
import type { Services } from '../services.js';
import { resolveSyncEvidenceFlag } from './vault-config.js';

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
    random: new FakeRandom(),
    cwd: '/ws',
    homedir: '/home/test',
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
    metricsMutex: new Map(),
    metricsSessionId: 'test-session',
    navReadBodyCount: 0,
    workspaceRoot: '/ws',
    platform: 'linux',
    username: 'testuser',
    ...overrides,
  };
}

describe('resolveSyncEvidenceFlag', () => {
  it('defaults to false when neither layer configures it', async () => {
    const services = makeServices();
    expect(await resolveSyncEvidenceFlag(services)).toBe(false);
  });

  it('reads true from the global layer (<homedir>/.chamba/config.json)', async () => {
    const services = makeServices({
      fs: new MemoryFilesystem({
        '/home/test/.chamba/config.json': JSON.stringify({
          version: 1,
          vault: { syncEvidence: true },
        }),
      }),
    });
    expect(await resolveSyncEvidenceFlag(services)).toBe(true);
  });

  it('reads true from the project layer (<wsRoot>/.chamba/config.json)', async () => {
    const services = makeServices({
      fs: new MemoryFilesystem({
        '/ws/.chamba/config.json': JSON.stringify({ version: 1, vault: { syncEvidence: true } }),
      }),
    });
    expect(await resolveSyncEvidenceFlag(services)).toBe(true);
  });

  it('project layer wins over global when they disagree', async () => {
    const services = makeServices({
      fs: new MemoryFilesystem({
        '/home/test/.chamba/config.json': JSON.stringify({
          version: 1,
          vault: { syncEvidence: true },
        }),
        '/ws/.chamba/config.json': JSON.stringify({
          version: 1,
          vault: { syncEvidence: false },
        }),
      }),
    });
    expect(await resolveSyncEvidenceFlag(services)).toBe(false);
  });

  it('a hostile/invalid config inside the worktree is never read — only homedir/wsRoot are', async () => {
    const services = makeServices({
      fs: new MemoryFilesystem({
        '/ws/chamba/.chamba/config.json': JSON.stringify({
          version: 1,
          vault: { syncEvidence: true },
        }),
      }),
    });
    // Neither of the two layers B9 permits has it set — default stands.
    expect(await resolveSyncEvidenceFlag(services)).toBe(false);
  });

  it('a malformed JSON layer is tolerated, never throws, and is treated as absent', async () => {
    const services = makeServices({
      fs: new MemoryFilesystem({
        '/home/test/.chamba/config.json': '{ not json',
      }),
    });
    await expect(resolveSyncEvidenceFlag(services)).resolves.toBe(false);
  });
});
