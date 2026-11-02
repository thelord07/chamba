/**
 * state-store-pending-hash.test.ts — PARCHE-010 R12/R15 tests for:
 *   - syncStateFileSchema round-trip with pendingJoinCodeHash
 *   - resetVaultState writes pendingJoinCodeHash
 *   - mergeIntoStateFile preserves pendingJoinCodeHash
 *   - clearPendingAdoption removes both pendingAdoption + pendingJoinCodeHash
 *   - pendingJoinCodeHashOf is deterministic and uses URL origin (trailing slash variants equal)
 *   - joinOnce writes exactly the expected hash
 */

import {
  clearPendingAdoption,
  FakeHash,
  FakeParche,
  joinOnce,
  MemoryFilesystem,
  mergeIntoStateFile,
  pendingJoinCodeHashOf,
  readState,
  resetVaultState,
  syncStateFileSchema,
  writeState,
} from '@chamba/core';
import { describe, expect, it } from 'vitest';

const FAKE_NOW = '2026-06-09T10:00:00.000Z';

function makeClock(now = FAKE_NOW) {
  const d = new Date(now);
  return { now: () => d, today: () => d.toISOString().slice(0, 10) };
}

function makeParche() {
  const parche = new FakeParche(makeClock());
  const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
  parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });
  return { parche, group };
}

// ─── Schema round-trip ───────────────────────────────────────────────────────

describe('syncStateFileSchema round-trip with pendingJoinCodeHash', () => {
  it('parses a state with pendingJoinCodeHash', () => {
    const input = {
      server: 'https://parche.example.com',
      slug: 'team-alpha',
      cursor: 0,
      files: {},
      pendingAdoption: true as const,
      pendingJoinCodeHash: 'abc123def456',
    };
    const result = syncStateFileSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pendingJoinCodeHash).toBe('abc123def456');
    }
  });

  it('parses a state without pendingJoinCodeHash (optional field)', () => {
    const input = {
      server: 'https://parche.example.com',
      slug: 'team-alpha',
      cursor: 0,
      files: {},
    };
    const result = syncStateFileSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.pendingJoinCodeHash).toBeUndefined();
    }
  });
});

// ─── resetVaultState ─────────────────────────────────────────────────────────

describe('resetVaultState writes pendingJoinCodeHash', () => {
  it('writes the hash when provided in meta', async () => {
    const fs = new MemoryFilesystem();
    const vaultDir = '/vault/team-alpha';
    await fs.mkdir(vaultDir);

    await resetVaultState(
      fs,
      vaultDir,
      {
        server: 'https://parche.example.com',
        slug: 'team-alpha',
        groupId: 'grp-001',
        pendingJoinCodeHash: 'deadbeef1234',
      },
      makeClock(),
    );

    const state = await readState(fs, vaultDir);
    expect(state).not.toBeNull();
    expect(state?.pendingJoinCodeHash).toBe('deadbeef1234');
    expect(state?.pendingAdoption).toBe(true);
    expect(state?.cursor).toBe(0);
  });

  it('does NOT write the hash when not provided in meta', async () => {
    const fs = new MemoryFilesystem();
    const vaultDir = '/vault/team-alpha';
    await fs.mkdir(vaultDir);

    await resetVaultState(
      fs,
      vaultDir,
      {
        server: 'https://parche.example.com',
        slug: 'team-alpha',
      },
      makeClock(),
    );

    const state = await readState(fs, vaultDir);
    expect(state?.pendingJoinCodeHash).toBeUndefined();
  });
});

// ─── mergeIntoStateFile ──────────────────────────────────────────────────────

describe('mergeIntoStateFile preserves pendingJoinCodeHash', () => {
  it('preserves hash from base after merging updated state', async () => {
    const fs = new MemoryFilesystem();
    const vaultDir = '/vault/team-alpha';
    await fs.mkdir(vaultDir);

    // Write initial state with hash
    await writeState(fs, vaultDir, {
      server: 'https://parche.example.com',
      slug: 'team-alpha',
      cursor: 0,
      files: {},
      pendingAdoption: true,
      pendingJoinCodeHash: 'preserved-hash-xyz',
    });

    const base = await readState(fs, vaultDir);
    expect(base).not.toBeNull();
    if (!base) throw new Error('base state is null');

    // Create an updated state (without pendingJoinCodeHash, simulating a sync result)
    const updated = {
      cursor: 5,
      files: { 'note.md': { syncedHash: 'abc' } },
    };

    // Merge
    const merged = mergeIntoStateFile(base, updated, '2026-06-09T10:00:00.000Z');
    expect(merged.pendingJoinCodeHash).toBe('preserved-hash-xyz');
    expect(merged.cursor).toBe(5);
  });

  it('does not add hash when base does not have it', async () => {
    const base = {
      server: 'https://parche.example.com',
      slug: 'team-alpha',
      cursor: 0,
      files: {},
    };

    const merged = mergeIntoStateFile(base, { cursor: 1, files: {} }, '2026-06-09T10:00:00.000Z');
    expect(merged.pendingJoinCodeHash).toBeUndefined();
  });
});

// ─── clearPendingAdoption ────────────────────────────────────────────────────

describe('clearPendingAdoption removes both pendingAdoption + pendingJoinCodeHash', () => {
  it('removes both fields from a state that has both', () => {
    const state = {
      server: 'https://parche.example.com',
      slug: 'team-alpha',
      cursor: 0,
      files: {},
      pendingAdoption: true as const,
      pendingJoinCodeHash: 'some-hash',
    };

    const cleared = clearPendingAdoption(state);
    expect(cleared.pendingAdoption).toBeUndefined();
    expect(cleared.pendingJoinCodeHash).toBeUndefined();
    // Other fields intact
    expect(cleared.cursor).toBe(0);
    expect(cleared.server).toBe('https://parche.example.com');
  });

  it('is a no-op on state without either field', () => {
    const state = {
      server: 'https://parche.example.com',
      slug: 'team-alpha',
      cursor: 0,
      files: {},
    };

    const cleared = clearPendingAdoption(state);
    expect(cleared).toEqual(state);
  });

  it('does not mutate the original state', () => {
    const state = {
      server: 'https://parche.example.com',
      slug: 'team-alpha',
      cursor: 0,
      files: {},
      pendingAdoption: true as const,
      pendingJoinCodeHash: 'some-hash',
    };

    const cleared = clearPendingAdoption(state);
    // Original is unchanged
    expect(state.pendingAdoption).toBe(true);
    expect(state.pendingJoinCodeHash).toBe('some-hash');
    // Cleared has neither
    expect(cleared.pendingAdoption).toBeUndefined();
    expect(cleared.pendingJoinCodeHash).toBeUndefined();
  });
});

// ─── pendingJoinCodeHashOf ───────────────────────────────────────────────────

describe('pendingJoinCodeHashOf — deterministic with FakeHash, uses URL origin', () => {
  it('is deterministic for the same server + code', async () => {
    const hash = new FakeHash();
    const h1 = await pendingJoinCodeHashOf(hash, 'https://parche.chamba.tools', 'K7QX-M2RP');
    const h2 = await pendingJoinCodeHashOf(hash, 'https://parche.chamba.tools', 'K7QX-M2RP');
    expect(h1).toBe(h2);
    expect(h1.length).toBe(64); // sha256 hex
  });

  it('trailing slash variant of server yields the same hash as without slash', async () => {
    const hash = new FakeHash();
    const h1 = await pendingJoinCodeHashOf(hash, 'https://parche.chamba.tools', 'K7QX-M2RP');
    const h2 = await pendingJoinCodeHashOf(hash, 'https://parche.chamba.tools/', 'K7QX-M2RP');
    // Both use origin ('https://parche.chamba.tools') — no trailing slash
    expect(h1).toBe(h2);
  });

  it('different server → different hash', async () => {
    const hash = new FakeHash();
    const h1 = await pendingJoinCodeHashOf(hash, 'https://parche.chamba.tools', 'K7QX-M2RP');
    const h2 = await pendingJoinCodeHashOf(hash, 'https://other.parche.dev', 'K7QX-M2RP');
    expect(h1).not.toBe(h2);
  });

  it('different code → different hash', async () => {
    const hash = new FakeHash();
    const h1 = await pendingJoinCodeHashOf(hash, 'https://parche.chamba.tools', 'K7QX-M2RP');
    const h2 = await pendingJoinCodeHashOf(hash, 'https://parche.chamba.tools', 'ZZZZ-ZZZZ');
    expect(h1).not.toBe(h2);
  });
});

// ─── joinOnce writes exactly the expected hash ───────────────────────────────

describe('joinOnce writes exactly the expected pendingJoinCodeHash', () => {
  it('writes the hash in state.json after a join with skipInitialSync:true', async () => {
    const { parche } = makeParche();
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const clock = makeClock();

    const result = await joinOnce(
      { fs, http: parche, hash, clock },
      {
        server: 'https://parche.chamba.tools',
        homedir: '/home/test',
        joinRequest: {
          code: 'K7QX-M2RP',
          name: 'Test User',
          email: 'test@example.com',
          deviceLabel: 'test-device',
        },
        skipInitialSync: true,
      },
    );

    const expectedHash = await pendingJoinCodeHashOf(
      hash,
      'https://parche.chamba.tools',
      'K7QX-M2RP',
    );
    const state = await readState(fs, result.vaultDir);
    expect(state?.pendingJoinCodeHash).toBe(expectedHash);
  });

  it('state.json does not contain the code in clear', async () => {
    const { parche } = makeParche();
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const clock = makeClock();

    const result = await joinOnce(
      { fs, http: parche, hash, clock },
      {
        server: 'https://parche.chamba.tools',
        homedir: '/home/test',
        joinRequest: {
          code: 'K7QX-M2RP',
          name: 'Test User',
          email: 'test@example.com',
          deviceLabel: 'test-device',
        },
        skipInitialSync: true,
      },
    );

    const stateJson = await fs.readFile(`${result.vaultDir}/.chamba-sync/state.json`);
    // The code must NOT appear in clear
    expect(stateJson).not.toContain('K7QX-M2RP');
    // The token must NOT appear in state.json
    expect(stateJson).not.toMatch(/pch_/);
  });

  it('after confirm, JSON.stringify(state) has no pendingJoinCodeHash', async () => {
    const { parche } = makeParche();
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const clock = makeClock();

    const result = await joinOnce(
      { fs, http: parche, hash, clock },
      {
        server: 'https://parche.chamba.tools',
        homedir: '/home/test',
        joinRequest: {
          code: 'K7QX-M2RP',
          name: 'Test User',
          email: 'test@example.com',
          deviceLabel: 'test-device',
        },
        skipInitialSync: true,
      },
    );

    // Simulate confirmation: clear pending adoption
    const stateBefore = await readState(fs, result.vaultDir);
    expect(stateBefore?.pendingJoinCodeHash).toMatch(/^[0-9a-f]{64}$/);
    if (!stateBefore) throw new Error('stateBefore is null');
    const cleared = clearPendingAdoption(stateBefore);
    await writeState(fs, result.vaultDir, cleared);

    // After clearing, no pendingJoinCodeHash in JSON
    const stateJson = await fs.readFile(`${result.vaultDir}/.chamba-sync/state.json`);
    expect(stateJson).not.toContain('pendingJoinCodeHash');
  });
});

// ─── credentials.json never contains token in state.json ────────────────────

describe('state.json never contains the token', () => {
  it('joinOnce: no pch_ token in state.json', async () => {
    const { parche } = makeParche();
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const clock = makeClock();

    const result = await joinOnce(
      { fs, http: parche, hash, clock },
      {
        server: 'https://parche.chamba.tools',
        homedir: '/home/test',
        joinRequest: {
          code: 'K7QX-M2RP',
          name: 'Test User',
          email: 'test@example.com',
          deviceLabel: 'test-device',
        },
        skipInitialSync: true,
      },
    );

    const stateJson = await fs.readFile(`${result.vaultDir}/.chamba-sync/state.json`);
    expect(stateJson).not.toMatch(/pch_/);
  });
});

// ─── CredentialsStore never written inside vault dir ────────────────────────

describe('CredentialsStore writes outside vault dir', () => {
  it('joinOnce: credentials.json is outside the vault directory', async () => {
    const { parche } = makeParche();
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const clock = makeClock();

    const result = await joinOnce(
      { fs, http: parche, hash, clock },
      {
        server: 'https://parche.chamba.tools',
        homedir: '/home/test',
        joinRequest: {
          code: 'K7QX-M2RP',
          name: 'Test User',
          email: 'test@example.com',
          deviceLabel: 'test-device',
        },
        skipInitialSync: true,
      },
    );

    const credPath = '/home/test/.chamba/credentials.json';
    const credExists = await fs.exists(credPath);
    expect(credExists).toBe(true);

    // credentials.json is NOT inside vault dir
    expect(credPath.startsWith(result.vaultDir)).toBe(false);
  });
});
