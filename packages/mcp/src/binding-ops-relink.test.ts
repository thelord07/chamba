/**
 * Regression: `vault link` rewrites matching parche.json files. The rewritten file must
 * stay a valid v1 binding with exactly the allowed keys — never the in-memory fields
 * (`scope`, `bindingPath`, `baseDir`) of a resolved binding.
 */
import {
  FakeHash,
  FakeParche,
  MemoryFilesystem,
  parcheFilePath,
  readParcheBinding,
  writeParcheBinding,
} from '@chamba/core';
import { describe, expect, it } from 'vitest';
import { updateBindingVaultDirForSlug } from './parche/binding-ops.js';
import type { Services } from './services.js';

const HOMEDIR = '/home/test';
const WORKSPACE = `${HOMEDIR}/Projects/ws`;
const SERVER = 'https://parche.chamba.tools';

function makeServices(fs: MemoryFilesystem): Services {
  const now = new Date('2026-06-09T10:00:00.000Z');
  const clock = { now: () => now, today: () => '2026-06-09' };
  return {
    fs,
    process: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    clock,
    system: {
      resources: () => ({ totalMemBytes: 1, freeMemBytes: 1, cpus: 1, loadAvg1: 0 }),
    },
    cwd: WORKSPACE,
    homedir: HOMEDIR,
    http: new FakeParche(clock),
    hash: new FakeHash(),
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
  };
}

const AUTO_SYNC = { enabled: false, pullTtlMin: 7 };

describe('updateBindingVaultDirForSlug keeps parche.json valid', () => {
  it('rewrites workspace and global bindings with exactly the v1 keys', async () => {
    const fs = new MemoryFilesystem();
    await fs.writeFile(`${WORKSPACE}/.chamba/workspace.md`, '# ws\n');
    const wsPath = parcheFilePath(WORKSPACE);
    const globalPath = parcheFilePath(HOMEDIR);
    await writeParcheBinding(fs, wsPath, {
      version: 1,
      server: SERVER,
      slug: 'team-alpha',
      vaultDir: 'vault',
      autoSync: AUTO_SYNC,
    });
    await writeParcheBinding(fs, globalPath, {
      version: 1,
      server: SERVER,
      slug: 'team-alpha',
      vaultDir: `${HOMEDIR}/old`,
      autoSync: AUTO_SYNC,
    });

    const updated = await updateBindingVaultDirForSlug(makeServices(fs), {
      slug: 'team-alpha',
      newVaultDir: `${WORKSPACE}/notes`,
    });
    expect(updated).toHaveLength(2);

    const ws = JSON.parse(await fs.readFile(wsPath));
    expect(ws).toEqual({
      version: 1,
      server: SERVER,
      slug: 'team-alpha',
      vaultDir: 'notes',
      autoSync: AUTO_SYNC,
    });
    const global = JSON.parse(await fs.readFile(globalPath));
    expect(global).toEqual({
      version: 1,
      server: SERVER,
      slug: 'team-alpha',
      vaultDir: `${WORKSPACE}/notes`,
      autoSync: AUTO_SYNC,
    });

    const reread = await readParcheBinding(fs, wsPath, { scope: 'workspace', baseDir: WORKSPACE });
    expect(reread.ok).toBe(true);
  });

  it('writeParcheBinding refuses extra keys (never persists a token)', async () => {
    const fs = new MemoryFilesystem();
    const path = parcheFilePath(WORKSPACE);
    await expect(
      writeParcheBinding(fs, path, {
        version: 1,
        server: SERVER,
        slug: 'team-alpha',
        vaultDir: 'vault',
        autoSync: AUTO_SYNC,
        token: 'pch_x',
      } as never),
    ).rejects.toThrow();
    expect(await fs.exists(path)).toBe(false);
  });
});
