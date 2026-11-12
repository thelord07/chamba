/**
 * state-store.test.ts — readState / writeState / mergeIntoStateFile unit tests.
 * Uses MemoryFilesystem. Never touches the real home directory.
 */

import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { mergeIntoStateFile, readState, syncStateFileSchema, writeState } from './state-store.js';

const VAULT = '/vault';

const BASE_STATE = {
  server: 'https://parche.example.com',
  slug: 'my-group',
  groupId: 'grp-abc123',
  cursor: 0,
  files: {},
};

describe('readState / writeState — atomic round-trip', () => {
  it('round-trips a state including groupId', async () => {
    const fs = new MemoryFilesystem();
    const state = {
      ...BASE_STATE,
      cursor: 42,
      files: { 'a.md': { syncedHash: 'abc123' }, 'b.md': { syncedHash: null } },
    };
    await writeState(fs, VAULT, state);
    const got = await readState(fs, VAULT);
    expect(got).not.toBeNull();
    if (!got) throw new Error('readState returned null');
    expect(got.cursor).toBe(42);
    expect(got.groupId).toBe('grp-abc123');
    expect(got.files['a.md']?.syncedHash).toBe('abc123');
    expect(got.files['b.md']?.syncedHash).toBeNull();
  });

  it('returns null for missing file', async () => {
    const fs = new MemoryFilesystem();
    const got = await readState(fs, VAULT);
    expect(got).toBeNull();
  });

  it('returns null for invalid JSON', async () => {
    const fs = new MemoryFilesystem();
    await fs.writeFile(`${VAULT}/.chamba-sync/state.json`, 'not valid json {');
    const got = await readState(fs, VAULT);
    expect(got).toBeNull();
  });

  it('returns null when schema validation fails (missing server field)', async () => {
    const fs = new MemoryFilesystem();
    const malformed = { cursor: 0, files: {} }; // missing server and slug
    await fs.writeFile(`${VAULT}/.chamba-sync/state.json`, JSON.stringify(malformed));
    const got = await readState(fs, VAULT);
    expect(got).toBeNull();
  });

  it('accepts state without groupId (backward compat)', async () => {
    const fs = new MemoryFilesystem();
    const withoutGroupId = {
      server: 'https://parche.example.com',
      slug: 'my-group',
      cursor: 0,
      files: {},
    };
    await fs.writeFile(`${VAULT}/.chamba-sync/state.json`, JSON.stringify(withoutGroupId));
    const got = await readState(fs, VAULT);
    expect(got).not.toBeNull();
    if (!got) throw new Error('readState returned null');
    expect(got.groupId).toBeUndefined();
  });
});

describe('syncStateFileSchema', () => {
  it('rejects negative cursor', () => {
    const result = syncStateFileSchema.safeParse({
      ...BASE_STATE,
      cursor: -1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty server', () => {
    const result = syncStateFileSchema.safeParse({ ...BASE_STATE, server: '' });
    expect(result.success).toBe(false);
  });
});

describe('mergeIntoStateFile', () => {
  it('merges cursor and files from SyncState into SyncStateFile, preserving groupId', () => {
    const base = { ...BASE_STATE, groupId: 'grp-xyz', lastSyncAt: '2026-10-29T10:00:00.000Z' };
    const syncState = { cursor: 5, files: { 'x.md': { syncedHash: 'hash1' } } };
    const merged = mergeIntoStateFile(base, syncState, '2026-10-29T12:00:00.000Z');
    expect(merged.cursor).toBe(5);
    expect(merged.files['x.md']?.syncedHash).toBe('hash1');
    expect(merged.groupId).toBe('grp-xyz');
    expect(merged.lastSyncAt).toBe('2026-10-29T12:00:00.000Z');
  });

  it('does not carry groupId when base has none', () => {
    const base = { server: 'https://s', slug: 'g', cursor: 0, files: {} };
    const syncState = { cursor: 1, files: {} };
    const merged = mergeIntoStateFile(base, syncState, '2026-10-29T12:00:00.000Z');
    expect(merged.groupId).toBeUndefined();
  });

  // ── CHAMBA-021 S6: blockedSecret ──────────────────────────────────────────

  it('preserves blockedSecret from base when newBlockedSecret is not given', () => {
    const blockedSecret = {
      'secret.md': {
        findings: [{ fingerprint: 'abc123def456', kind: 'aws-access-key', line: 3 }],
        detectedAt: '2026-10-29T10:00:00.000Z',
      },
    };
    const base = { ...BASE_STATE, blockedSecret };
    const merged = mergeIntoStateFile(base, { cursor: 1, files: {} }, '2026-10-29T12:00:00.000Z');
    expect(merged.blockedSecret).toEqual(blockedSecret);
  });

  it('replaces blockedSecret when newBlockedSecret is given', () => {
    const base = {
      ...BASE_STATE,
      blockedSecret: {
        'old.md': {
          findings: [{ fingerprint: 'f1', kind: 'assignment', line: 1 }],
          detectedAt: '2026-10-29T09:00:00.000Z',
        },
      },
    };
    const next = {
      'new.md': {
        findings: [{ fingerprint: 'f2', kind: 'parche-token', line: 2 }],
        detectedAt: '2026-10-29T12:00:00.000Z',
      },
    };
    const merged = mergeIntoStateFile(
      base,
      { cursor: 1, files: {} },
      '2026-10-29T12:00:00.000Z',
      undefined,
      next,
    );
    expect(merged.blockedSecret).toEqual(next);
  });

  it('omits blockedSecret entirely when the map is empty', () => {
    const base = { ...BASE_STATE };
    const merged = mergeIntoStateFile(
      base,
      { cursor: 1, files: {} },
      '2026-10-29T12:00:00.000Z',
      undefined,
      {},
    );
    expect(merged.blockedSecret).toBeUndefined();
  });
});
