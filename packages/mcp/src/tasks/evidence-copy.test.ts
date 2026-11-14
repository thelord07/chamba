/**
 * tasks/evidence-copy.test.ts — CHAMBA-022 (C7, N2)
 *
 * N2: a symlink escaping the QA evidence root can't be exercised with
 * `MemoryFilesystem` (its `realpath` is lexical, `memory-filesystem.ts:188-191`)
 * and creating real symlinks on Windows needs privileges — so this ONE test
 * uses the real `NodeFilesystem` and is skipped on win32.
 */

import { promises as fsPromises } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NodeFilesystem } from '@chamba/adapters';
import { FakeHash } from '@chamba/core';
import { describe, expect, it } from 'vitest';
import type { Services } from '../services.js';
import { copyQaEvidence } from './evidence-copy.js';

function nodeServices(wsRoot: string, homedir: string): Services {
  return {
    fs: new NodeFilesystem(),
    process: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    clock: { now: () => new Date('2026-11-13T00:00:00Z'), today: () => '2026-11-13' },
    system: {
      resources: () => ({ totalMemBytes: 0, freeMemBytes: 0, cpus: 1, loadAvg1: 0 }),
    },
    http: { request: async () => ({ status: 500, headers: {}, body: '' }) } as never,
    hash: new FakeHash(),
    random: { hex: () => '0000' },
    cwd: wsRoot,
    homedir,
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
    workspaceRoot: wsRoot,
    platform: process.platform,
    username: 'testuser',
  };
}

describe('N2: symlink containment on real filesystem', () => {
  it.skipIf(process.platform === 'win32')(
    'a symlink inside qa-evidence pointing outside it is skipped, never copied',
    async () => {
      const tmpRootRaw = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'chamba-qa-sym-'));
      const tmpRoot = await fsPromises.realpath(tmpRootRaw);
      const wsRoot = path.join(tmpRoot, 'ws');
      const vaultPath = path.join(tmpRoot, 'vault');
      const qaDir = path.join(wsRoot, '.chamba', 'qa-evidence', 'CHAMBA-900', 'run1');
      const outsideDir = path.join(tmpRoot, 'outside');

      try {
        await fsPromises.mkdir(qaDir, { recursive: true });
        await fsPromises.mkdir(outsideDir, { recursive: true });
        await fsPromises.mkdir(vaultPath, { recursive: true });
        await fsPromises.writeFile(path.join(outsideDir, 'secret.png'), 'not-really-an-image');
        await fsPromises.writeFile(path.join(qaDir, 'report.md'), 'todo bien');
        await fsPromises.symlink(path.join(outsideDir, 'secret.png'), path.join(qaDir, 'spy.png'));

        const services = nodeServices(wsRoot, tmpRoot);
        const result = await copyQaEvidence({
          services,
          sourcePath: qaDir,
          vaultPath,
          workItem: 'CHAMBA-900',
          runId: 'run-20261113-01',
        });

        // N12: narrow via the thrown error, not a redundant `expect(ok).toBe(true)`
        // AFTER that guard already made it unreachable otherwise.
        if (!result.ok) {
          throw new Error(`expected ok, got: ${result.error}`);
        }
        expect(result.notes.some((n) => n.includes('spy.png') && n.includes('symlink'))).toBe(true);
        expect(result.copied.some((c) => c.path.endsWith('spy.png'))).toBe(false);
        expect(result.copied.some((c) => c.path.endsWith('report.md'))).toBe(true);
      } finally {
        await fsPromises.rm(tmpRoot, { recursive: true, force: true });
      }
    },
  );
});
