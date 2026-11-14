/**
 * state-store.test.ts — readState / writeState / mergeIntoStateFile unit tests.
 * Uses MemoryFilesystem. Never touches the real home directory.
 */

import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import type { SyncStateFile } from './state-store.js';
import { mergeIntoStateFile, readState, syncStateFileSchema, writeState } from './state-store.js';

const VAULT = '/vault';
const now = '2026-10-29T10:00:00.000Z';

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

  // ── CHAMBA-023 S5: blockedSecretServer ────────────────────────────────────

  it('preserves blockedSecretServer from base when newBlockedSecretServer is not given', () => {
    const blockedSecretServer = {
      'c.md': {
        kinds: ['assignment'],
        hash: 'h1',
        allowDigest: '',
        detectedAt: '2026-10-29T10:00:00.000Z',
      },
    };
    const base = { ...BASE_STATE, blockedSecretServer };
    const merged = mergeIntoStateFile(base, { cursor: 1, files: {} }, '2026-10-29T12:00:00.000Z');
    expect(merged.blockedSecretServer).toEqual(blockedSecretServer);
  });

  it('replaces blockedSecretServer when newBlockedSecretServer is given (6th param)', () => {
    const base = {
      ...BASE_STATE,
      blockedSecretServer: {
        'old.md': {
          kinds: ['jwt'],
          hash: 'hold',
          allowDigest: '',
          detectedAt: '2026-10-29T09:00:00.000Z',
        },
      },
    };
    const next = {
      'new.md': {
        kinds: ['stripe-secret-key'],
        hash: 'hnew',
        allowDigest: 'fp1',
        detectedAt: '2026-10-29T12:00:00.000Z',
      },
    };
    const merged = mergeIntoStateFile(
      base,
      { cursor: 1, files: {} },
      '2026-10-29T12:00:00.000Z',
      undefined,
      undefined,
      next,
    );
    expect(merged.blockedSecretServer).toEqual(next);
  });

  it('omits blockedSecretServer entirely when the map is empty', () => {
    const base = { ...BASE_STATE };
    const merged = mergeIntoStateFile(
      base,
      { cursor: 1, files: {} },
      '2026-10-29T12:00:00.000Z',
      undefined,
      undefined,
      {},
    );
    expect(merged.blockedSecretServer).toBeUndefined();
  });
  // ── CHAMBA-022 (O1): evidenceImagesWarned — once true, always true ───────

  it('evidenceImagesWarned stays undefined when never set', () => {
    const base = { ...BASE_STATE };
    const merged = mergeIntoStateFile(base, { cursor: 1, files: {} }, '2026-11-13T12:00:00.000Z');
    expect(merged.evidenceImagesWarned).toBeUndefined();
  });

  it('sets evidenceImagesWarned to true when passed true (7th param)', () => {
    const base = { ...BASE_STATE };
    const merged = mergeIntoStateFile(
      base,
      { cursor: 1, files: {} },
      '2026-11-13T12:00:00.000Z',
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(merged.evidenceImagesWarned).toBe(true);
  });

  it('preserves evidenceImagesWarned:true from base when the new value is undefined (never un-warns)', () => {
    const base = { ...BASE_STATE, evidenceImagesWarned: true };
    const merged = mergeIntoStateFile(base, { cursor: 1, files: {} }, '2026-11-13T12:00:00.000Z');
    expect(merged.evidenceImagesWarned).toBe(true);
  });

  it('passing false explicitly does NOT clear a prior true (one-way latch, never un-sets)', () => {
    const base = { ...BASE_STATE, evidenceImagesWarned: true };
    const merged = mergeIntoStateFile(
      base,
      { cursor: 1, files: {} },
      '2026-11-13T12:00:00.000Z',
      undefined,
      undefined,
      undefined,
      false,
    );
    expect(merged.evidenceImagesWarned).toBe(true);
  });
});

describe('syncStateFileSchema — blockedSecretServer (CHAMBA-023 S5)', () => {
  it('accepts a v1.15.0 state on disk with no blockedSecretServer field (backward compat)', () => {
    const result = syncStateFileSchema.safeParse(BASE_STATE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blockedSecretServer).toBeUndefined();
      expect(result.data.cursor).toBe(0);
    }
  });

  it('a garbage-shaped blockedSecretServer is caught to undefined, cursor/files stay intact', () => {
    const result = syncStateFileSchema.safeParse({
      ...BASE_STATE,
      cursor: 7,
      files: { 'a.md': { syncedHash: 'h' } },
      blockedSecretServer: { 'c.md': { kinds: 'not-an-array' } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blockedSecretServer).toBeUndefined();
      expect(result.data.cursor).toBe(7);
      expect(result.data.files['a.md']?.syncedHash).toBe('h');
    }
  });

  it('accepts a well-formed blockedSecretServer entry', () => {
    const result = syncStateFileSchema.safeParse({
      ...BASE_STATE,
      blockedSecretServer: {
        'c.md': {
          kinds: ['assignment'],
          hash: 'h1',
          allowDigest: 'fp1',
          detectedAt: '2026-10-29T10:00:00.000Z',
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blockedSecretServer?.['c.md']?.kinds).toEqual(['assignment']);
      expect(result.data.blockedSecretServer?.['c.md']?.allowDigest).toBe('fp1');
    }
  });

  // ── Review B2: `kinds` must NOT require .min(1) ───────────────────────────

  it('B2 — round-trips through write/read with `kinds: []` on one entry alongside a valid entry', async () => {
    const fs = new MemoryFilesystem();
    const state: SyncStateFile = {
      ...BASE_STATE,
      blockedSecretServer: {
        // A defensively-parsed 422 body with no kinds at all.
        'empty-kinds.md': { kinds: [], hash: 'h1', allowDigest: '', detectedAt: now },
        'normal.md': { kinds: ['assignment'], hash: 'h2', allowDigest: 'fp1', detectedAt: now },
      },
    };
    await writeState(fs, VAULT, state);
    const got = await readState(fs, VAULT);
    expect(got).not.toBeNull();
    // Both entries survive the round-trip — `kinds: []` on one path never
    // invalidates the whole map (which would have silently un-blocked
    // 'normal.md' too).
    expect(got?.blockedSecretServer?.['empty-kinds.md']).toEqual({
      kinds: [],
      hash: 'h1',
      allowDigest: '',
      detectedAt: now,
    });
    expect(got?.blockedSecretServer?.['normal.md']).toEqual({
      kinds: ['assignment'],
      hash: 'h2',
      allowDigest: 'fp1',
      detectedAt: now,
    });
  });
});
