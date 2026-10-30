/**
 * parche/active-vault.test.ts — Tests for resolveActiveParcheVault.
 * PARCHE-009 AC10: custom vault dir is recognized by autosync.
 */

import { FakeHash, FakeParche, MemoryFilesystem } from '@chamba/core';
import { describe, expect, it } from 'vitest';
import type { Services } from '../services.js';
import { resolveActiveParcheVault } from './active-vault.js';

const FAKE_NOW = '2026-06-09T10:00:00.000Z';

function makeClock(now = FAKE_NOW) {
  const d = new Date(now);
  return { now: () => d, today: () => d.toISOString().slice(0, 10) };
}

function makeServices(overrides: Partial<Services> = {}): Services {
  const parche = new FakeParche(makeClock());
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
    homedir: '/home/test',
    http: parche,
    hash: new FakeHash(),
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
    ...overrides,
  };
}

const SERVER = 'https://parche.example.com';
const SLUG = 'my-vault';
const TOKEN = 'pch_test_token';

async function seedVault(
  fs: MemoryFilesystem,
  vaultDir: string,
  opts: { pendingAdoption?: true } = {},
): Promise<void> {
  await fs.mkdir(`${vaultDir}/.obsidian`);
  await fs.mkdir(`${vaultDir}/.chamba-sync`);
  const state = {
    server: SERVER,
    slug: SLUG,
    cursor: 0,
    files: {},
    lastSyncAt: FAKE_NOW,
    ...(opts.pendingAdoption ? { pendingAdoption: true } : {}),
  };
  await fs.writeFile(`${vaultDir}/.chamba-sync/state.json`, JSON.stringify(state));
}

async function seedCred(
  fs: MemoryFilesystem,
  homedir: string,
  opts: { dir?: string } = {},
): Promise<void> {
  await fs.mkdir(`${homedir}/.chamba`);
  const creds = {
    [`${SERVER}|${SLUG}`]: {
      token: TOKEN,
      user: { id: 'u1', name: 'Joys' },
      device: { id: 'd1', label: 'laptop' },
      role: 'editor',
      ...(opts.dir ? { dir: opts.dir } : {}),
    },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(creds));
  await fs.writeBytes(`${homedir}/.chamba/credentials.json`, bytes, { mode: 0o600 });
}

describe('resolveActiveParcheVault (AC10)', () => {
  it('returns vault when detection.path matches cred.dir', async () => {
    const customDir = '/my/custom/vault';
    const fs = new MemoryFilesystem();
    await seedVault(fs, customDir);
    await seedCred(fs, '/home/test', { dir: customDir });

    const svc = makeServices({ fs, obsidianVaultPath: customDir });
    const result = await resolveActiveParcheVault(svc);

    expect(result).not.toBeNull();
    expect(result?.vaultDir).toBe(customDir);
    expect(result?.slug).toBe(SLUG);
  });

  it('returns null when detection.path differs from cred.dir (realpath guard)', async () => {
    const customDir = '/my/custom/vault';
    const otherDir = '/other/vault';
    const fs = new MemoryFilesystem();
    await seedVault(fs, otherDir); // state.json is in otherDir
    await seedCred(fs, '/home/test', { dir: customDir }); // cred points to customDir
    await fs.mkdir(customDir); // make customDir exist

    // Detection finds otherDir but cred says customDir — realpaths differ
    const svc = makeServices({ fs, obsidianVaultPath: otherDir });
    const result = await resolveActiveParcheVault(svc);
    expect(result).toBeNull();
  });

  it('backward compat: cred without dir + default detection path → still recognized', async () => {
    const defaultDir = '/home/test/.chamba/vaults/my-vault';
    const fs = new MemoryFilesystem();
    await seedVault(fs, defaultDir);
    await seedCred(fs, '/home/test'); // no dir in cred

    const svc = makeServices({ fs, obsidianVaultPath: defaultDir });
    const result = await resolveActiveParcheVault(svc);

    expect(result).not.toBeNull();
    expect(result?.vaultDir).toBe(defaultDir);
  });

  it('returns null when vault is pendingAdoption (R1)', async () => {
    const customDir = '/my/custom/vault';
    const fs = new MemoryFilesystem();
    await seedVault(fs, customDir, { pendingAdoption: true });
    await seedCred(fs, '/home/test', { dir: customDir });

    const svc = makeServices({ fs, obsidianVaultPath: customDir });
    const result = await resolveActiveParcheVault(svc);
    expect(result).toBeNull();
  });

  it('returns null when the configured vault path was deleted (D2)', async () => {
    const customDir = '/my/missing/vault';
    const fs = new MemoryFilesystem();
    await fs.mkdir('/home/test/.chamba');
    await seedCred(fs, '/home/test', { dir: customDir });

    const svc = makeServices({ fs, obsidianVaultPath: customDir });
    const result = await resolveActiveParcheVault(svc);
    expect(result).toBeNull();
    expect(await fs.exists(customDir)).toBe(false);
  });

  it('returns null when the detected vault is fine but cred.dir points to a deleted folder (D2)', async () => {
    // Detection succeeds on the old folder (still has .obsidian + state), but the
    // credential was re-linked to a folder that no longer exists: never sync either.
    const oldDir = '/my/old/vault';
    const missingDir = '/my/new/vault';
    const fs = new MemoryFilesystem();
    await seedVault(fs, oldDir);
    await seedCred(fs, '/home/test', { dir: missingDir });

    const svc = makeServices({ fs, obsidianVaultPath: oldDir });
    const result = await resolveActiveParcheVault(svc);
    expect(result).toBeNull();
    expect(await fs.exists(missingDir)).toBe(false);
  });
});
