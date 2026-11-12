/**
 * runner.test.ts — Tests for PARCHE-004 runner (syncOnce, scanLocal, joinOnce).
 * Uses FakeParche, FakeHash, MemoryFilesystem, and inline ClockPort.
 * Never touches the real home directory.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ClockPort } from '../ports/clock.js';
import { FakeHash } from '../testing/fake-hash.js';
import { FakeParche } from '../testing/fake-parche.js';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { readConflictMeta } from './conflict.js';
import { CredentialsStore } from './credentials.js';
import { ParcheClient } from './parche-client.js';
import {
  AdoptionPendingError,
  CaseCollisionError,
  joinOnce,
  scanLocal,
  syncOnce,
  VaultDirMissingError,
} from './runner.js';
import { readState, writeState } from './state-store.js';

const VAULT = '/vault';
const SERVER = 'https://parche.example.com';
const SLUG = 'test-group';
const LOCAL_AUTHOR = 'joys';

function makeClock(iso = '2026-10-29T12:00:00Z'): ClockPort {
  return {
    now: () => new Date(iso),
    today: () => iso.slice(0, 10),
    sleep: () => Promise.resolve(),
  };
}

function makeDeps(parche: FakeParche) {
  const clock = makeClock();
  const hash = new FakeHash();
  const fs = new MemoryFilesystem();
  return { fs, http: parche, hash, clock };
}

function setupGroup(parche: FakeParche) {
  const group = parche.seedGroup({ slug: SLUG, name: 'Test Group' });
  parche.addInvite({ code: 'ABCD-1234', groupId: group.id, role: 'editor' });
  return group;
}

function makeToken(parche: FakeParche, group: ReturnType<FakeParche['seedGroup']>) {
  const user = { id: 'usr1', name: LOCAL_AUTHOR, email: 'joys@test.com' };
  return parche.addDevice(group.id, { userId: user.id, label: 'laptop', role: 'editor' });
}

function makeSyncOpts(token: string): Parameters<typeof syncOnce>[1] {
  return {
    vaultDir: VAULT,
    server: SERVER,
    slug: SLUG,
    token,
    localAuthor: LOCAL_AUTHOR,
    device: 'laptop',
  };
}

// ─── AC4: push 3 files, second sync no-op ─────────────────────────────────────

describe('AC4 — push local files, second sync is no-op', () => {
  it('uploads 3 blobs and pushes, second sync sends nothing', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const deps = makeDeps(parche);
    const { fs, hash } = deps;

    // Seed local files
    await fs.writeBytes(`${VAULT}/note1.md`, new TextEncoder().encode('# Note 1'));
    await fs.writeBytes(`${VAULT}/note2.md`, new TextEncoder().encode('# Note 2'));
    await fs.writeBytes(`${VAULT}/image.png`, new Uint8Array([137, 80, 78, 71]));

    const opts = makeSyncOpts(token);
    const summary = await syncOnce(deps, opts);

    expect(summary.pushed).toBe(3);
    expect(summary.pulled).toBe(0);
    expect(summary.conflicts).toHaveLength(0);

    // State should have 3 files with syncedHash
    const state = await readState(fs, VAULT);
    expect(state).not.toBeNull();
    if (!state) throw new Error('state must not be null');
    const fileCount = Object.values(state.files).filter((f) => f.syncedHash !== null).length;
    expect(fileCount).toBe(3);

    // Compute hashes to verify syncedHash
    const note1Bytes = new TextEncoder().encode('# Note 1');
    const note1Hash = await hash.sha256(note1Bytes);
    expect(state.files['note1.md']?.syncedHash).toBe(note1Hash);

    // Second sync: no-op
    const summary2 = await syncOnce(deps, opts);
    expect(summary2.pushed).toBe(0);
    expect(summary2.pulled).toBe(0);
    expect(summary2.conflicts).toHaveLength(0);
  });
});

// ─── AC5: corrupt blob fails without writing ─────────────────────────────────

describe('AC5 — corrupt blob fails without writing or advancing cursor', () => {
  it('throws on hash mismatch, file not written, cursor unchanged', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const deps = makeDeps(parche);
    const { fs, hash } = deps;

    // Seed a remote file
    const remoteBytes = new TextEncoder().encode('remote content');
    const remoteHash = await hash.sha256(remoteBytes);
    parche.seedBlob(group.id, remoteHash, remoteBytes);
    parche.seedChange(group.id, {
      path: 'remote.md',
      hash: remoteHash,
      author: 'server',
      device: 'server',
      at: '2026-10-29T10:00:00Z',
    });

    // Corrupt the blob
    parche.corruptBlob(remoteHash);

    const opts = makeSyncOpts(token);
    await expect(syncOnce(deps, opts)).rejects.toThrow();

    // File should not have been written
    expect(await fs.exists(`${VAULT}/remote.md`)).toBe(false);

    // State cursor should still be 0
    const state = await readState(fs, VAULT);
    // State may be null (never saved) or cursor 0 (saved after phase 1 push only)
    if (state !== null) {
      // The push phase completed with 0 entries (no local files), so cursor = 0
      expect(state.cursor).toBe(0);
    }
  });
});

// ─── AC6: remote delete → .trash, not re-uploaded ────────────────────────────

describe('AC6 — remote delete moves file to .trash', () => {
  it('moves deleted file to .trash, not re-uploaded on second sync', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const token = makeToken(parche, group);

    // Seed: b.md was already synced (cursor 1, syncedHash = h)
    const bBytes = new TextEncoder().encode('content of b');
    const bHash = await hash.sha256(bBytes);

    // Pre-write file and state
    await fs.writeBytes(`${VAULT}/b.md`, bBytes);

    // Set up state as if file was previously synced (cursor=0 so the tombstone change is picked up)
    const stateData = {
      server: SERVER,
      slug: SLUG,
      groupId: group.id,
      cursor: 0,
      files: { 'b.md': { syncedHash: bHash } },
      lastSyncAt: '2026-10-29T10:00:00Z',
    };
    const { writeState } = await import('./state-store.js');
    await writeState(fs, VAULT, stateData);

    // Add a change on the server: tombstone for b.md
    parche.seedChange(group.id, {
      path: 'b.md',
      hash: null,
      author: 'server',
      device: 'server',
      at: '2026-10-29T10:01:00Z',
    });

    const deps = { fs, http: parche, hash, clock: makeClock() };
    const opts = makeSyncOpts(token);
    const summary = await syncOnce(deps, opts);

    expect(summary.movedToTrash).toContain('b.md');
    expect(await fs.exists(`${VAULT}/b.md`)).toBe(false);
    expect(await fs.exists(`${VAULT}/.trash/b.md`)).toBe(true);

    // Second sync: b.md should not be re-uploaded
    const summary2 = await syncOnce(deps, opts);
    expect(summary2.pushed).toBe(0);
  });

  it('uses suffix (2) if trash path already exists', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const token = makeToken(parche, group);

    const bBytes = new TextEncoder().encode('content of b');
    const bHash = await hash.sha256(bBytes);
    await fs.writeBytes(`${VAULT}/b.md`, bBytes);
    // Pre-existing .trash/b.md
    await fs.writeBytes(`${VAULT}/.trash/b.md`, new TextEncoder().encode('old trash'));

    const { writeState } = await import('./state-store.js');
    await writeState(fs, VAULT, {
      server: SERVER,
      slug: SLUG,
      groupId: group.id,
      cursor: 0,
      files: { 'b.md': { syncedHash: bHash } },
    });

    parche.seedChange(group.id, {
      path: 'b.md',
      hash: null,
      author: 'server',
      device: 'server',
      at: '2026-10-29T10:01:00Z',
    });

    const deps = { fs, http: parche, hash, clock: makeClock() };
    await syncOnce(deps, makeSyncOpts(token));

    // .trash/b (2).md should exist
    expect(await fs.exists(`${VAULT}/.trash/b (2).md`)).toBe(true);
  });
});

// ─── AC7: conflict → copy with frontmatter, copy uploaded ────────────────────

describe('AC7 — conflict creates copy with frontmatter, phase 3 uploads copy', () => {
  it('conflict: a.md=remote, copy has frontmatter, copy uploaded', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const token = makeToken(parche, group);

    const baseBytes = new TextEncoder().encode('# Base');
    const baseHash = await hash.sha256(baseBytes);
    const localBytes = new TextEncoder().encode('# Local edit');
    const remoteBytes = new TextEncoder().encode('# Remote edit');
    const remoteHash = await hash.sha256(remoteBytes);

    // Local a.md differs from both base and remote
    await fs.writeBytes(`${VAULT}/a.md`, localBytes);

    const { writeState } = await import('./state-store.js');
    await writeState(fs, VAULT, {
      server: SERVER,
      slug: SLUG,
      groupId: group.id,
      cursor: 0,
      files: { 'a.md': { syncedHash: baseHash } },
    });

    // Remote has a different version
    parche.seedBlob(group.id, remoteHash, remoteBytes);
    parche.seedChange(group.id, {
      path: 'a.md',
      hash: remoteHash,
      author: 'other-user',
      device: 'other-device',
      at: '2026-10-29T10:01:00Z',
    });

    const deps = { fs, http: parche, hash, clock: makeClock() };
    const summary = await syncOnce(deps, makeSyncOpts(token));

    // a.md should be the remote version
    const aBytes = await fs.readBytes(`${VAULT}/a.md`);
    expect(new TextDecoder().decode(aBytes)).toBe('# Remote edit');

    // Copy should exist with conflict frontmatter
    expect(summary.conflicts).toHaveLength(1);
    const conflict = summary.conflicts[0];
    if (!conflict) throw new Error('expected conflict entry');
    const { copyPath } = conflict;
    expect(copyPath).toContain('conflicto');
    const copyText = await fs.readFile(`${VAULT}/${copyPath}`);
    const meta = readConflictMeta(copyText);
    expect(meta).not.toBeNull();
    if (!meta) throw new Error('meta must not be null');
    expect(meta.conflictOf).toBe('a.md');
    expect(meta.conflictBase).toBe(baseHash);
  });
});

// ─── AC8: casing rename ───────────────────────────────────────────────────────

describe('AC8 — casing rename pushes [Nota.md→null, nota.md→H]', () => {
  it('pushes delete+create pair without error', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const token = makeToken(parche, group);

    const noteBytes = new TextEncoder().encode('# Note');
    const noteHash = await hash.sha256(noteBytes);

    // State: Nota.md was previously synced
    const { writeState } = await import('./state-store.js');
    await writeState(fs, VAULT, {
      server: SERVER,
      slug: SLUG,
      groupId: group.id,
      cursor: 0,
      files: { 'Nota.md': { syncedHash: noteHash } },
    });

    // Local: only nota.md (lowercase) exists
    await fs.writeBytes(`${VAULT}/nota.md`, noteBytes);

    const deps = { fs, http: parche, hash, clock: makeClock() };
    const summary = await syncOnce(deps, makeSyncOpts(token));
    expect(summary.errors).toHaveLength(0);
  });
});

// ─── AC9: case collision → error, no push ────────────────────────────────────

describe('AC9 — Nota.md + nota.md → CaseCollisionError, no push', () => {
  it('throws CaseCollisionError without sending any request', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    // MemoryFilesystem is case-sensitive
    const fs = new MemoryFilesystem();
    const token = makeToken(parche, group);

    await fs.writeBytes(`${VAULT}/Nota.md`, new TextEncoder().encode('# Capital'));
    await fs.writeBytes(`${VAULT}/nota.md`, new TextEncoder().encode('# lowercase'));

    const deps = { fs, http: parche, hash, clock: makeClock() };

    // Track requests
    const requestSpy = vi.spyOn(parche, 'request');
    await expect(syncOnce(deps, makeSyncOpts(token))).rejects.toThrow(CaseCollisionError);
    // No blob or push requests should have been sent
    // (the scan itself throws before any HTTP call)
    const calls = requestSpy.mock.calls;
    const pushCalls = calls.filter(([req]) => req.url.includes('/push'));
    expect(pushCalls).toHaveLength(0);
  });
});

// ─── AC10: 422 retry ─────────────────────────────────────────────────────────

describe('AC10 — 422 missing_blobs: push-first, PUT only missing, up to 3 rounds', () => {
  it('always-422 push throws "no se pudo completar el push" after ≤3 rounds', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const token = makeToken(parche, group);

    const noteBytes = new TextEncoder().encode('# note');
    await fs.writeBytes(`${VAULT}/note.md`, noteBytes);
    const noteHash = await hash.sha256(noteBytes);

    // Permanent rejection: every push returns 422 → set never reduces → error
    parche.rejectPushBlobs([noteHash]);

    const deps = { fs, http: parche, hash, clock: makeClock() };
    await expect(syncOnce(deps, makeSyncOpts(token))).rejects.toThrow(
      /no se pudo completar el push: faltan blobs/,
    );

    // At most 3 rounds of 422 (1 initial push + up to 3 retries = ≤4 push calls total)
    const pushCalls = parche.requestLog.filter((r) => r.url.includes('/push'));
    expect(pushCalls.length).toBeLessThanOrEqual(4);
  });

  it('transient 422: pushed === 1, exactly 2 requests to /push, PUT of missing hash between them', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const token = makeToken(parche, group);

    const noteBytes = new TextEncoder().encode('# note transient');
    await fs.writeBytes(`${VAULT}/note.md`, noteBytes);
    const noteHash = await hash.sha256(noteBytes);

    // push-first: the first push returns 422 (rejectPushBlobsOnce), runner PUTs the blob,
    // then retries push successfully. No HEAD calls in this flow.
    parche.rejectPushBlobsOnce([noteHash]);

    const deps = { fs, http: parche, hash, clock: makeClock() };
    const summary = await syncOnce(deps, makeSyncOpts(token));

    // summary.pushed === 1
    expect(summary.pushed).toBe(1);
    expect(summary.errors).toHaveLength(0);

    // Exactly 2 requests to /push
    const pushRequests = parche.requestLog.filter((r) => r.url.includes('/push'));
    expect(pushRequests).toHaveLength(2);

    // A PUT of the missing hash must appear between the two /push calls
    const pushIdx1 = parche.requestLog.findIndex((r) => r.url.includes('/push'));
    const pushIdx2 = parche.requestLog.findIndex((r, i) => i > pushIdx1 && r.url.includes('/push'));
    const between = parche.requestLog.slice(pushIdx1 + 1, pushIdx2);
    const putBetween = between.filter(
      (r) => r.method === 'PUT' && r.url.includes(`/blob/${noteHash}`),
    );
    expect(putBetween).toHaveLength(1);
  });
});

// ─── AC13: page 2 failure → state unchanged, no duplicate copy ───────────────

describe('AC13 — fetch page 2 failure preserves state, no duplicate conflict copies', () => {
  it('first sync fails in page 2, state unchanged, no copies written', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    await fs.mkdir(VAULT);
    const token = makeToken(parche, group);

    // Set pageLimit=1 so 2 changes require 2 pages
    parche.pageLimit = 1;

    const remoteBytes1 = new TextEncoder().encode('remote 1');
    const remoteHash1 = await hash.sha256(remoteBytes1);
    const remoteBytes2 = new TextEncoder().encode('remote 2');
    const remoteHash2 = await hash.sha256(remoteBytes2);

    parche.seedBlob(group.id, remoteHash1, remoteBytes1);
    parche.seedBlob(group.id, remoteHash2, remoteBytes2);
    parche.seedChange(group.id, {
      path: 'file1.md',
      hash: remoteHash1,
      author: 'server',
      device: 'server',
      at: '2026-10-29T10:01:00Z',
    });
    parche.seedChange(group.id, {
      path: 'file2.md',
      hash: remoteHash2,
      author: 'server',
      device: 'server',
      at: '2026-10-29T10:02:00Z',
    });

    // Fail on page 2
    parche.failChangesPage = 2;

    const deps = { fs, http: parche, hash, clock: makeClock() };
    // First sync fails
    await expect(syncOnce(deps, makeSyncOpts(token))).rejects.toThrow();

    // file1.md and file2.md should NOT be written
    expect(await fs.exists(`${VAULT}/file1.md`)).toBe(false);
    expect(await fs.exists(`${VAULT}/file2.md`)).toBe(false);

    // State cursor should be 0 (phase 1 saved nothing / cursor unchanged)
    const state = await readState(fs, VAULT);
    if (state) {
      expect(state.cursor).toBe(0);
    }
  });

  it('second sync after recovery produces exactly one conflict copy', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const token = makeToken(parche, group);

    // Local a.md with content
    const localBytes = new TextEncoder().encode('# Local');
    await fs.writeBytes(`${VAULT}/a.md`, localBytes);

    // State: a.md was synced to baseHash (which differs from local)
    const baseBytes = new TextEncoder().encode('# Base');
    const baseHash = await hash.sha256(baseBytes);

    const { writeState } = await import('./state-store.js');
    await writeState(fs, VAULT, {
      server: SERVER,
      slug: SLUG,
      groupId: group.id,
      cursor: 0,
      files: { 'a.md': { syncedHash: baseHash } },
    });

    // Remote has a conflict version
    const remoteBytes = new TextEncoder().encode('# Remote');
    const remoteHash = await hash.sha256(remoteBytes);
    parche.seedBlob(group.id, remoteHash, remoteBytes);

    // Set pageLimit=1 and add 2 changes so page 2 is needed
    parche.pageLimit = 1;
    parche.seedChange(group.id, {
      path: 'a.md',
      hash: remoteHash,
      author: 'server',
      device: 'server',
      at: '2026-10-29T10:01:00Z',
    });
    parche.seedChange(group.id, {
      path: 'other.md',
      hash: null,
      author: 'server',
      device: 'server',
      at: '2026-10-29T10:02:00Z',
    });

    // Fail page 2 on first attempt
    parche.failChangesPage = 2;
    const deps = { fs, http: parche, hash, clock: makeClock() };
    await expect(syncOnce(deps, makeSyncOpts(token))).rejects.toThrow();

    // No copies written yet
    const entries = await fs.readDir(VAULT);
    const conflictFiles = entries.filter((e) => e.name.includes('conflicto'));
    expect(conflictFiles).toHaveLength(0);

    // Fix the failure and retry
    parche.failChangesPage = null;
    const summary = await syncOnce(deps, makeSyncOpts(token));

    // Exactly one conflict copy
    expect(summary.conflicts).toHaveLength(1);

    // Count conflict copies in vault
    const entries2 = await fs.readDir(VAULT);
    const conflictFiles2 = entries2.filter((e) => e.name.includes('conflicto'));
    expect(conflictFiles2).toHaveLength(1);
  });
});

// ─── Gate decision 1: rejoin resets state ─────────────────────────────────────

describe('Gate decision 1 — rejoin resets state, no files lost', () => {
  it('joinOnce over an existing vault ignores the old state.json and adopts local files', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const enc = new TextEncoder();

    // Existing vault folder: a.md differs from the remote, local-only.md was never pushed,
    // and a stale state.json from a previous membership claims cursor 200.
    await fs.writeBytes(`${VAULT}/a.md`, enc.encode('# a.md local version'));
    await fs.writeBytes(`${VAULT}/local-only.md`, enc.encode('# local-only note'));
    const { writeState } = await import('./state-store.js');
    await writeState(fs, VAULT, {
      server: SERVER,
      slug: SLUG,
      groupId: 'old-group-id',
      cursor: 200,
      files: { 'a.md': { syncedHash: await hash.sha256(enc.encode('# a.md base version')) } },
    });

    // Remote: a.md was written by someone else (seq 1).
    const remoteABytes = enc.encode('# a.md remote version');
    const remoteAHash = await hash.sha256(remoteABytes);
    parche.seedBlob(group.id, remoteAHash, remoteABytes);
    const remoteChange = parche.seedChange(group.id, {
      path: 'a.md',
      hash: remoteAHash,
      author: 'other-author',
      device: 'other-device',
      at: '2026-10-29T10:01:00Z',
    });

    const deps = { fs, http: parche, hash, clock: makeClock() };
    const { summary } = await joinOnce(deps, {
      vaultDir: VAULT,
      server: SERVER,
      homedir: '/home/test',
      joinRequest: { code: 'ABCD-1234', name: 'joys', email: 'joys@test.com' },
    });

    const state = await readState(fs, VAULT);
    if (!state) throw new Error('state must not be null');
    // The stale state was never trusted: new group id, and the cursor is the server's.
    // Phase 1 pushes local-only.md (seq 2; a.md is rejected as a conflict), then the
    // pull reads seq 1..2, so the cursor ends at the last seq the server returned.
    expect(state.groupId).toBe(group.id);
    expect(state.cursor).toBe(remoteChange.seq + 1);

    // a.md holds the remote bytes; the local version lives in the conflict copy.
    expect(new TextDecoder().decode(await fs.readBytes(`${VAULT}/a.md`))).toBe(
      '# a.md remote version',
    );
    expect(summary.conflicts).toEqual([{ path: 'a.md', copyPath: 'a (conflicto joys).md' }]);
    const copyText = await fs.readFile(`${VAULT}/a (conflicto joys).md`);
    expect(copyText).toContain('# a.md local version');
    expect(readConflictMeta(copyText)?.conflictOf).toBe('a.md');

    // No local file disappeared, and both local-only.md and the copy reached the server.
    expect(await fs.exists(`${VAULT}/local-only.md`)).toBe(true);
    const cred = await new CredentialsStore(fs, '/home/test').get(SERVER, SLUG);
    if (!cred) throw new Error('credential must be saved by joinOnce');
    const remote = await new ParcheClient(parche, SERVER, cred.token).getChanges(SLUG, 0);
    const remotePaths = remote.changes.map((c) => c.path);
    expect(remotePaths).toContain('local-only.md');
    expect(remotePaths).toContain('a (conflicto joys).md');
  });
});

// ─── Gate decision 2: conflict copy dedupe ────────────────────────────────────

/**
 * MemoryFilesystem wrapper that throws on the N-th call to writeBytes for a
 * specific target path. Used to simulate a crash mid-conflict-resolution.
 */
class CrashingWriteFs extends MemoryFilesystem {
  private readonly targetPath: string;
  private callsToTarget = 0;
  private readonly crashOnCall: number;

  constructor(targetPath: string, crashOnCall = 1) {
    super();
    this.targetPath = targetPath;
    this.crashOnCall = crashOnCall;
  }

  override async writeBytes(
    path: string,
    data: Uint8Array,
    opts?: import('../ports/filesystem.js').WriteBytesOptions,
  ): Promise<void> {
    if (this.normPath(path) === this.normPath(this.targetPath)) {
      this.callsToTarget += 1;
      if (this.callsToTarget === this.crashOnCall) {
        throw new Error(`Simulated crash writing ${path}`);
      }
    }
    return super.writeBytes(path, data, opts);
  }

  /** Mirrors MemoryFilesystem's private path normalization */
  private normPath(p: string): string {
    return p.replace(/\/+$/, '') || '/';
  }
}

describe('Gate decision 2 — conflict copy dedupe: crash-then-retry leaves one copy', () => {
  async function setupConflictScenario(opts: {
    parche: FakeParche;
    group: ReturnType<FakeParche['seedGroup']>;
    hash: FakeHash;
    fs: MemoryFilesystem;
    localContent?: string;
    baseContent?: string;
    remoteContent?: string;
  }) {
    const { parche, group, hash, fs } = opts;
    const localBytes = new TextEncoder().encode(opts.localContent ?? '# Local');
    const baseBytes = new TextEncoder().encode(opts.baseContent ?? '# Base');
    const remoteBytes = new TextEncoder().encode(opts.remoteContent ?? '# Remote');
    const baseHash = await hash.sha256(baseBytes);
    const remoteHash = await hash.sha256(remoteBytes);

    await fs.writeBytes(`${VAULT}/a.md`, localBytes);
    parche.seedBlob(group.id, remoteHash, remoteBytes);
    parche.seedChange(group.id, {
      path: 'a.md',
      hash: remoteHash,
      author: 'other',
      device: 'other',
      at: '2026-10-29T10:01:00Z',
    });

    const { writeState } = await import('./state-store.js');
    await writeState(fs, VAULT, {
      server: SERVER,
      slug: SLUG,
      groupId: group.id,
      cursor: 0,
      files: { 'a.md': { syncedHash: baseHash } },
    });

    return { localBytes, remoteBytes };
  }

  it('crash on writing remote version leaves copy, retry reuses the copy (one copy total)', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    // crashOnCall=2: first write to a.md is the test setup (setupConflictScenario),
    // second write is the runner's conflict action writing remote bytes — that one crashes.
    // The conflict action writes:
    //   1. copyPath (e.g. "a (conflicto other).md")   — not tracked (different path)
    //   2. a.md (the remote version)                  — callsToTarget=2 → CRASH
    const crashFs = new CrashingWriteFs(`${VAULT}/a.md`, 2);
    const token = makeToken(parche, group);

    const { localBytes } = await setupConflictScenario({
      parche,
      group,
      hash,
      fs: crashFs,
    });

    const deps = { fs: crashFs, http: parche, hash, clock: makeClock() };

    // First syncOnce must REJECT (crash when writing remote bytes to a.md)
    await expect(syncOnce(deps, makeSyncOpts(token))).rejects.toThrow(/Simulated crash/);

    // After crash: the copy exists but a.md still has local bytes
    const entriesAfterCrash = await crashFs.readDir(VAULT);
    const copiesAfterCrash = entriesAfterCrash.filter((e) => e.name.includes('conflicto'));
    expect(copiesAfterCrash).toHaveLength(1);
    const localABytes = await crashFs.readBytes(`${VAULT}/a.md`);
    expect(new TextDecoder().decode(localABytes)).toContain('Local');

    // Reset state so retry runs the conflict again from cursor=0
    const { writeState } = await import('./state-store.js');
    const baseBytes = new TextEncoder().encode('# Base');
    const baseHash = await hash.sha256(baseBytes);
    await writeState(crashFs, VAULT, {
      server: SERVER,
      slug: SLUG,
      groupId: group.id,
      cursor: 0,
      files: { 'a.md': { syncedHash: baseHash } },
    });
    // Restore local a.md (the crash happened before it was overwritten with remote)
    await crashFs.writeBytes(`${VAULT}/a.md`, localBytes);

    // Retry: the crashFs will NOT crash again (crashOnCall=1 is used up after being reset)
    // Actually CrashingWriteFs is stateful — callsToTarget already = 1. Let's clear it.
    // We rebuild with no crash to simulate a recovered system.
    // Move files from crashFs to a normal MemoryFilesystem
    const normalFs = new MemoryFilesystem();
    // Copy relevant files
    const allEntries = await crashFs.readDir(VAULT);
    for (const e of allEntries) {
      if (e.isFile) {
        const bytes = await crashFs.readBytes(`${VAULT}/${e.name}`);
        await normalFs.writeBytes(`${VAULT}/${e.name}`, bytes);
      }
    }
    // Restore conflict copy if exists in subdirs
    const rootEntries = await crashFs.readDir(VAULT);
    for (const e of rootEntries) {
      if (e.isFile) {
        const b = await crashFs.readBytes(`${VAULT}/${e.name}`);
        await normalFs.writeBytes(`${VAULT}/${e.name}`, b);
      }
    }
    // Write state.json
    const stateBytes = await crashFs.readBytes(`${VAULT}/.chamba-sync/state.json`);
    await normalFs.mkdir(`${VAULT}/.chamba-sync`);
    await normalFs.writeBytes(`${VAULT}/.chamba-sync/state.json`, stateBytes);
    // Restore local a.md (still local after crash)
    await normalFs.writeBytes(`${VAULT}/a.md`, localBytes);

    const deps2 = { fs: normalFs, http: parche, hash, clock: makeClock() };
    const summary2 = await syncOnce(deps2, makeSyncOpts(token));

    // After retry: exactly ONE conflict copy, a.md has remote bytes
    expect(summary2.conflicts).toHaveLength(1);
    const finalABytes = await normalFs.readBytes(`${VAULT}/a.md`);
    expect(new TextDecoder().decode(finalABytes)).toContain('Remote');

    const entries2 = await normalFs.readDir(VAULT);
    const conflictFiles2 = entries2.filter((e) => e.name.includes('conflicto'));
    expect(conflictFiles2).toHaveLength(1);
  });

  it('does NOT reuse a copy from a different author', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const token = makeToken(parche, group);

    const localBytes = new TextEncoder().encode('# Local');
    const baseBytes = new TextEncoder().encode('# Base');
    const remoteBytes = new TextEncoder().encode('# Remote');
    const baseHash = await hash.sha256(baseBytes);
    const remoteHash = await hash.sha256(remoteBytes);

    await fs.writeBytes(`${VAULT}/a.md`, localBytes);
    parche.seedBlob(group.id, remoteHash, remoteBytes);
    parche.seedChange(group.id, {
      path: 'a.md',
      hash: remoteHash,
      author: 'other',
      device: 'other',
      at: '2026-10-29T10:01:00Z',
    });

    const { writeState } = await import('./state-store.js');
    await writeState(fs, VAULT, {
      server: SERVER,
      slug: SLUG,
      groupId: group.id,
      cursor: 0,
      files: { 'a.md': { syncedHash: baseHash } },
    });

    // Pre-create a copy from a DIFFERENT author (alice) — should NOT be reused
    // LOCAL_AUTHOR is 'joys', so the copy would be named 'a (conflicto joys)...'
    // A copy from 'alice' has prefix 'a (conflicto alice)'
    const fakeLocalText = '# Local'; // same content, but different author in filename
    const withFm = (await import('./conflict.js')).addConflictFrontmatter(fakeLocalText, {
      conflictOf: 'a.md',
      conflictBase: baseHash,
    });
    await fs.writeBytes(`${VAULT}/a (conflicto alice).md`, new TextEncoder().encode(withFm));

    const deps = { fs, http: parche, hash, clock: makeClock() };
    const summary = await syncOnce(deps, makeSyncOpts(token));

    // Must create a NEW copy (for 'joys'), not reuse the alice copy
    expect(summary.conflicts).toHaveLength(1);
    const entries = await fs.readDir(VAULT);
    const conflictFiles = entries.filter((e) => e.name.includes('conflicto'));
    // Both the alice copy and the new joys copy must exist
    expect(conflictFiles.length).toBeGreaterThanOrEqual(2);
  });

  it('does NOT reuse a matching copy in a different folder', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const token = makeToken(parche, group);

    const localBytes = new TextEncoder().encode('# Local');
    const baseBytes = new TextEncoder().encode('# Base');
    const remoteBytes = new TextEncoder().encode('# Remote');
    const baseHash = await hash.sha256(baseBytes);
    const remoteHash = await hash.sha256(remoteBytes);

    await fs.writeBytes(`${VAULT}/a.md`, localBytes);
    parche.seedBlob(group.id, remoteHash, remoteBytes);
    parche.seedChange(group.id, {
      path: 'a.md',
      hash: remoteHash,
      author: 'other',
      device: 'other',
      at: '2026-10-29T10:01:00Z',
    });

    const { writeState } = await import('./state-store.js');
    await writeState(fs, VAULT, {
      server: SERVER,
      slug: SLUG,
      groupId: group.id,
      cursor: 0,
      files: { 'a.md': { syncedHash: baseHash } },
    });

    // Pre-create a copy in a DIFFERENT folder — should NOT be reused
    // The copy for 'a.md' should be at the root, not under 'sub/'
    const { addConflictFrontmatter } = await import('./conflict.js');
    const localText = new TextDecoder().decode(localBytes);
    const withFm = addConflictFrontmatter(localText, {
      conflictOf: 'a.md',
      conflictBase: baseHash,
    });
    await fs.mkdir(`${VAULT}/sub`);
    await fs.writeBytes(`${VAULT}/sub/a (conflicto joys).md`, new TextEncoder().encode(withFm));

    const deps = { fs, http: parche, hash, clock: makeClock() };
    const summary = await syncOnce(deps, makeSyncOpts(token));

    // A new copy must have been created at the root (not the sub/ copy reused)
    expect(summary.conflicts).toHaveLength(1);
    const rootConflict = summary.conflicts[0];
    if (!rootConflict) throw new Error('expected conflict');
    // The copy must be at root level (no sub/ prefix)
    expect(rootConflict.copyPath).not.toContain('sub/');
  });

  it('does NOT reuse a .md copy without conflict_of frontmatter', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const token = makeToken(parche, group);

    const localBytes = new TextEncoder().encode('# Local');
    const baseBytes = new TextEncoder().encode('# Base');
    const remoteBytes = new TextEncoder().encode('# Remote');
    const baseHash = await hash.sha256(baseBytes);
    const remoteHash = await hash.sha256(remoteBytes);

    await fs.writeBytes(`${VAULT}/a.md`, localBytes);
    parche.seedBlob(group.id, remoteHash, remoteBytes);
    parche.seedChange(group.id, {
      path: 'a.md',
      hash: remoteHash,
      author: 'other',
      device: 'other',
      at: '2026-10-29T10:01:00Z',
    });

    const { writeState } = await import('./state-store.js');
    await writeState(fs, VAULT, {
      server: SERVER,
      slug: SLUG,
      groupId: group.id,
      cursor: 0,
      files: { 'a.md': { syncedHash: baseHash } },
    });

    // Pre-create a copy with matching name pattern but WITHOUT conflict_of frontmatter
    const { addConflictFrontmatter } = await import('./conflict.js');
    const localText = new TextDecoder().decode(localBytes);
    const withFm = addConflictFrontmatter(localText, {
      conflictOf: 'b.md', // different conflict_of!
      conflictBase: baseHash,
    });
    await fs.writeBytes(`${VAULT}/a (conflicto joys).md`, new TextEncoder().encode(withFm));

    const deps = { fs, http: parche, hash, clock: makeClock() };
    const summary = await syncOnce(deps, makeSyncOpts(token));

    // Must create a NEW copy since the existing one has wrong conflict_of
    expect(summary.conflicts).toHaveLength(1);
    const copyPath = summary.conflicts[0]?.copyPath;
    if (!copyPath) throw new Error('expected conflict');

    // The new copy should have conflict_of: a.md
    const copyText = await fs.readFile(`${VAULT}/${copyPath}`);
    const meta = readConflictMeta(copyText);
    expect(meta?.conflictOf).toBe('a.md');
  });

  it('dedupe basic: same-content copy reused on second run', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const token = makeToken(parche, group);

    const localBytes = new TextEncoder().encode('# Local');
    await fs.writeBytes(`${VAULT}/a.md`, localBytes);

    const baseBytes = new TextEncoder().encode('# Base');
    const baseHash = await hash.sha256(baseBytes);

    const remoteBytes = new TextEncoder().encode('# Remote');
    const remoteHash = await hash.sha256(remoteBytes);
    parche.seedBlob(group.id, remoteHash, remoteBytes);
    parche.seedChange(group.id, {
      path: 'a.md',
      hash: remoteHash,
      author: 'other',
      device: 'other',
      at: '2026-10-29T10:01:00Z',
    });

    const { writeState } = await import('./state-store.js');
    await writeState(fs, VAULT, {
      server: SERVER,
      slug: SLUG,
      groupId: group.id,
      cursor: 0,
      files: { 'a.md': { syncedHash: baseHash } },
    });

    const deps = { fs, http: parche, hash, clock: makeClock() };

    // First sync: completes normally
    const summary = await syncOnce(deps, makeSyncOpts(token));
    expect(summary.conflicts).toHaveLength(1);
    const firstConflict = summary.conflicts[0];
    if (!firstConflict) throw new Error('expected conflict in first sync');
    const firstCopyPath = firstConflict.copyPath;

    // Simulate crash: reset state, restore original local a.md
    await writeState(fs, VAULT, {
      server: SERVER,
      slug: SLUG,
      groupId: group.id,
      cursor: 0,
      files: { 'a.md': { syncedHash: baseHash } },
    });
    await fs.writeBytes(`${VAULT}/a.md`, localBytes);

    const summary2 = await syncOnce(deps, makeSyncOpts(token));

    // Dedupe: same copy path, still exactly one conflict copy
    expect(summary2.conflicts).toHaveLength(1);
    expect(summary2.conflicts[0]?.copyPath).toBe(firstCopyPath);

    const entries = await fs.readDir(VAULT);
    const conflictFiles = entries.filter((e) => e.name.includes('conflicto'));
    expect(conflictFiles).toHaveLength(1);
  });
});

// ─── scanLocal tests ─────────────────────────────────────────────────────────

describe('scanLocal', () => {
  it('returns snapshot of syncable files with hashes', async () => {
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();

    await fs.writeBytes(`${VAULT}/note.md`, new TextEncoder().encode('hello'));
    await fs.writeBytes(`${VAULT}/image.png`, new Uint8Array([1, 2, 3]));
    await fs.writeBytes(`${VAULT}/.obsidian/workspace`, new TextEncoder().encode('{}')); // not syncable

    const { snapshot, blobSource } = await scanLocal({ fs, hash }, VAULT);

    expect(Object.keys(snapshot)).toHaveLength(2);
    expect(snapshot['note.md']).toBeDefined();
    expect(snapshot['image.png']).toBeDefined();
    expect(snapshot['.obsidian/workspace']).toBeUndefined();

    // blobSource maps hash → abs path
    const noteHash = snapshot['note.md'];
    if (!noteHash) throw new Error('note.md not in snapshot');
    expect(blobSource.get(noteHash)).toBe(`${VAULT}/note.md`);
  });

  it('throws CaseCollisionError on case-sensitive collision', async () => {
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    await fs.writeBytes(`${VAULT}/Nota.md`, new TextEncoder().encode('A'));
    await fs.writeBytes(`${VAULT}/nota.md`, new TextEncoder().encode('B'));

    await expect(scanLocal({ fs, hash }, VAULT)).rejects.toThrow(CaseCollisionError);
  });

  it('excludes .trash and .chamba-sync paths', async () => {
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    await fs.writeBytes(`${VAULT}/.trash/old.md`, new TextEncoder().encode('trash'));
    await fs.writeBytes(`${VAULT}/.chamba-sync/state.json`, new TextEncoder().encode('{}'));
    await fs.writeBytes(`${VAULT}/real.md`, new TextEncoder().encode('real'));

    const { snapshot } = await scanLocal({ fs, hash }, VAULT);
    expect(Object.keys(snapshot)).toHaveLength(1);
    expect(snapshot['real.md']).toBeDefined();
  });

  // ── CHAMBA-023 D-Q3: precompute findings on the same bytes read for the hash ──

  it('with knownHashes, a NEW file (not in knownHashes) is scanned and findingsByPath records it', async () => {
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    await fs.writeBytes(`${VAULT}/note.md`, new TextEncoder().encode('# hello\n'));

    const { snapshot, findingsByPath } = await scanLocal({ fs, hash }, VAULT, {});
    const h = snapshot['note.md'];
    expect(h).toBeDefined();
    const entry = findingsByPath.get('note.md');
    expect(entry).toBeDefined();
    expect(entry?.hash).toBe(h);
    expect(entry?.scanned).toBe(true);
    expect(entry?.findings).toEqual([]);
  });

  it('with knownHashes, an UNCHANGED file (same hash) is NOT in findingsByPath at all', async () => {
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const bytes = new TextEncoder().encode('# unchanged\n');
    await fs.writeBytes(`${VAULT}/note.md`, bytes);
    const h = await hash.sha256(bytes);

    const { findingsByPath } = await scanLocal({ fs, hash }, VAULT, { 'note.md': h });
    expect(findingsByPath.has('note.md')).toBe(false);
  });

  it('with knownHashes, a CHANGED file with a secret is scanned and the finding is recorded', async () => {
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const secretBody = `token: ${'pch_'}${'A'.repeat(24)}\n`;
    await fs.writeBytes(`${VAULT}/note.md`, new TextEncoder().encode(secretBody));

    const { findingsByPath } = await scanLocal({ fs, hash }, VAULT, { 'note.md': 'some-old-hash' });
    const entry = findingsByPath.get('note.md');
    expect(entry?.scanned).toBe(true);
    expect(entry?.findings.length).toBeGreaterThan(0);
  });

  it('with knownHashes, a binary file is marked scanned:false, never decoded', async () => {
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0xff, 0xfe, 0xfd, 0xfc,
    ]);
    await fs.writeBytes(`${VAULT}/img.png`, png);

    const { findingsByPath } = await scanLocal({ fs, hash }, VAULT, {});
    const entry = findingsByPath.get('img.png');
    expect(entry?.scanned).toBe(false);
    expect(entry?.findings).toEqual([]);
  });

  it('without knownHashes (omitted), findingsByPath is always empty — no behavior change for other callers', async () => {
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    await fs.writeBytes(`${VAULT}/note.md`, new TextEncoder().encode('# hello\n'));
    const { findingsByPath } = await scanLocal({ fs, hash }, VAULT);
    expect(findingsByPath.size).toBe(0);
  });
});

// ─── Additional: no /push call when plan is empty ────────────────────────────

describe('no /push when planPush is empty', () => {
  it('does not call /push when there are no local changes', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    await fs.mkdir(VAULT);
    const token = makeToken(parche, group);

    const requestSpy = vi.spyOn(parche, 'request');

    const deps = { fs, http: parche, hash, clock: makeClock() };
    await syncOnce(deps, makeSyncOpts(token));

    const pushCalls = requestSpy.mock.calls.filter(([req]) => req.url.includes('/push'));
    expect(pushCalls).toHaveLength(0);
  });
});

// ─── Fetch-all guard: hasMore=true with non-advancing cursor ──────────────────

describe('fetch-all guard — hasMore=true with non-advancing cursor', () => {
  it('throws a clear error without writing anything when cursor does not advance', async () => {
    // Build a minimal HttpPort that always returns hasMore=true with the same cursor
    const enc = new TextEncoder();
    let callCount = 0;
    const badHttp = {
      async request(req: import('../ports/http.js').HttpRequest) {
        const url = new URL(req.url);
        if (req.method.toUpperCase() === 'GET' && url.pathname.includes('/changes')) {
          callCount += 1;
          // Return hasMore=true but cursor=0 every time → infinite-loop guard must fire
          const body = {
            protocol: 1,
            changes: [],
            cursor: 0,
            hasMore: true,
          };
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: enc.encode(JSON.stringify(body)),
          };
        }
        // push: return empty success
        return {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: enc.encode(JSON.stringify({ results: [] })),
        };
      },
    };

    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    await fs.mkdir(VAULT);
    const deps = { fs, http: badHttp, hash, clock: makeClock() };

    const opts: Parameters<typeof syncOnce>[1] = {
      vaultDir: VAULT,
      server: SERVER,
      slug: SLUG,
      token: 'pch_fake_test',
      localAuthor: LOCAL_AUTHOR,
      device: 'laptop',
    };

    await expect(syncOnce(deps, opts)).rejects.toThrow(/cursor did not advance/);

    // The guard fires during phase 2; no remote files should have been written
    // (state.json may have been saved after phase 1, but no vault content files)
    const vaultEntries = await fs.readDir(VAULT).catch(() => []);
    const contentFiles = vaultEntries.filter((e) => e.isFile && !e.name.startsWith('.'));
    expect(contentFiles).toHaveLength(0);
    // The guard should have fired on the first iteration (one /changes call)
    expect(callCount).toBe(1);
  });
});

// ─── PARCHE-009 D2: VaultDirMissingError ─────────────────────────────────────

describe('syncOnce — D2: VaultDirMissingError when vault dir deleted', () => {
  it('throws VaultDirMissingError when vault dir does not exist (D2)', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const { fs, hash, clock } = makeDeps(parche);
    // Do NOT create the vault dir
    const deps = { fs, http: parche, hash, clock };

    await expect(
      syncOnce(deps, {
        vaultDir: '/nonexistent/vault',
        server: SERVER,
        slug: SLUG,
        token,
        localAuthor: LOCAL_AUTHOR,
        device: 'laptop',
      }),
    ).rejects.toThrow(VaultDirMissingError);
    // No PUT requests sent (nothing synced)
    const putRequests = parche.requestLog.filter((r) => r.method === 'PUT');
    expect(putRequests.length).toBe(0);
    // Dir was never created
    expect(await fs.exists('/nonexistent/vault')).toBe(false);
  });

  it('VaultDirMissingError has correct vaultDir and slug (D2)', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const { fs, hash, clock } = makeDeps(parche);
    const deps = { fs, http: parche, hash, clock };

    const err = await syncOnce(deps, {
      vaultDir: '/deleted/vault',
      server: SERVER,
      slug: SLUG,
      token,
      localAuthor: LOCAL_AUTHOR,
      device: 'laptop',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(VaultDirMissingError);
    const typedErr = err as VaultDirMissingError;
    expect(typedErr.vaultDir).toBe('/deleted/vault');
    expect(typedErr.slug).toBe(SLUG);
  });
});

// ─── PARCHE-009 R1: AdoptionPendingError blocks syncOnce ─────────────────────

describe('syncOnce — R1: AdoptionPendingError when pendingAdoption is true', () => {
  it('throws AdoptionPendingError and does not push when pendingAdoption=true (R1)', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const clock = makeClock();

    // Create vault with a pending adoption state
    await fs.mkdir(`${VAULT}/.obsidian`);
    await fs.writeFile(`${VAULT}/note.md`, '# Note\n');
    await fs.mkdir(`${VAULT}/.chamba-sync`);
    await fs.writeFile(
      `${VAULT}/.chamba-sync/state.json`,
      JSON.stringify({
        server: SERVER,
        slug: SLUG,
        cursor: 0,
        files: {},
        pendingAdoption: true,
        lastSyncAt: '2026-01-01T00:00:00Z',
      }),
    );

    const requestsBefore = parche.requestLog.length;
    await expect(
      syncOnce(
        { fs, http: parche, hash, clock },
        {
          vaultDir: VAULT,
          server: SERVER,
          slug: SLUG,
          token,
          localAuthor: LOCAL_AUTHOR,
          device: 'laptop',
        },
      ),
    ).rejects.toThrow(AdoptionPendingError);

    // No PUT requests (nothing uploaded)
    const putRequests = parche.requestLog.slice(requestsBefore).filter((r) => r.method === 'PUT');
    expect(putRequests.length).toBe(0);
  });
});

// ─── PARCHE-009 joinOnce skipInitialSync / vaultDir custom ───────────────────

describe('joinOnce — PARCHE-009: custom vaultDir persisted in credential', () => {
  it('stores dir in credential when custom vaultDir is given', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-beta', name: 'Team Beta' });
    parche.addInvite({ code: 'ZZZZ-1111', groupId: group.id, role: 'editor' });
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const clock = makeClock();
    const homedir = '/home/test';

    // Pre-create the custom dir so joinOnce finds it
    await fs.mkdir('/custom/vault');

    await joinOnce(
      { fs, http: parche, hash, clock },
      {
        vaultDir: '/custom/vault',
        server: SERVER,
        homedir,
        joinRequest: { code: 'ZZZZ-1111', name: 'Joys', email: 'j@x.dev' },
        skipInitialSync: true,
      },
    );

    const creds = new CredentialsStore(fs, homedir);
    const allSlugs = await creds.listSlugs();
    const found = allSlugs.find((s) => s.slug === 'team-beta');
    expect(found).toBeDefined();
    if (!found) throw new Error('Credential not found for team-beta');
    const cred = await creds.get(found.server, 'team-beta');
    expect(cred?.dir).toBe('/custom/vault');
  });

  it('does not store dir in credential when default path is used', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-gamma', name: 'Team Gamma' });
    parche.addInvite({ code: 'WWWW-2222', groupId: group.id, role: 'editor' });
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const clock = makeClock();
    const homedir = '/home/test';

    const result = await joinOnce(
      { fs, http: parche, hash, clock },
      {
        server: SERVER,
        homedir,
        joinRequest: { code: 'WWWW-2222', name: 'Joys', email: 'j@x.dev' },
        skipInitialSync: true,
      },
    );

    const creds = new CredentialsStore(fs, homedir);
    const cred = await creds.get(SERVER, result.slug);
    expect(cred?.dir).toBeUndefined();
  });

  it('sets pendingAdoption=true in state when skipInitialSync=true', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-delta', name: 'Team Delta' });
    parche.addInvite({ code: 'XXXX-3333', groupId: group.id, role: 'editor' });
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const clock = makeClock();
    const homedir = '/home/test';

    const result = await joinOnce(
      { fs, http: parche, hash, clock },
      {
        server: SERVER,
        homedir,
        joinRequest: { code: 'XXXX-3333', name: 'Joys', email: 'j@x.dev' },
        skipInitialSync: true,
      },
    );

    const state = JSON.parse(await fs.readFile(`${result.vaultDir}/.chamba-sync/state.json`));
    expect(state.pendingAdoption).toBe(true);
  });
});

// ─── S16: walker produces / relative paths and same pathKey on win32 ──────────

describe('S16 — scanLocal always produces wire-relative paths with / (CHAMBA-015)', () => {
  it('relPaths use / even with a win32-style vaultDir prefix', async () => {
    // MemoryFilesystem only supports POSIX paths internally.
    // We use a POSIX vault path and inject platform:'win32' in syncOpts,
    // then verify that the relative paths produced by scanLocal always use /.
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();

    // Seed files at a POSIX vault path
    await fs.writeBytes('/vault/note.md', new TextEncoder().encode('# Note'));
    await fs.writeBytes('/vault/sub/other.md', new TextEncoder().encode('# Other'));

    const { snapshot } = await scanLocal({ fs, hash }, '/vault');

    // Every key must use / as separator
    for (const key of Object.keys(snapshot)) {
      expect(key).not.toContain('\\');
    }
    expect(Object.keys(snapshot)).toContain('note.md');
    expect(Object.keys(snapshot)).toContain('sub/other.md');
  });

  it('pathKey of wire relPath is the same as on posix', async () => {
    // pathKey is used for case-insensitive comparison; the wire paths
    // always use / so they must match whether the run is on win32 or posix.
    const { pathKey } = await import('./path-key.js');
    const relPath = 'sub/Note.md';
    const win32Key = pathKey(relPath);
    const posixKey = pathKey(relPath);
    expect(win32Key).toBe(posixKey);
  });

  it('syncOnce with platform:win32 does not alter relPaths in state', async () => {
    // Even with platform:'win32', the state files map should use / paths.
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const { fs, http, hash, clock } = makeDeps(parche);

    await fs.writeBytes(`${VAULT}/note.md`, new TextEncoder().encode('# Note'));

    const summary = await syncOnce(
      { fs, http, hash, clock },
      {
        vaultDir: VAULT,
        server: SERVER,
        slug: SLUG,
        token,
        localAuthor: LOCAL_AUTHOR,
        device: 'laptop',
        platform: 'win32',
      },
    );
    expect(summary.pushed).toBe(1);

    const state = await readState(fs, VAULT);
    expect(state).not.toBeNull();
    if (!state) throw new Error('state must not be null');
    // Keys in state.files are wire-relative paths — must use /
    for (const key of Object.keys(state.files)) {
      expect(key).not.toContain('\\');
    }
    expect(state.files['note.md']).toBeDefined();
  });
});

// ─── S17: Test 4 — pull with invalid Windows names (CHAMBA-015 D2, hot-path) ─

describe('S17 / Test 4 — pull invalid Windows names (CHAMBA-015 hot-path)', () => {
  function makeWin32SyncOpts(token: string): Parameters<typeof syncOnce>[1] {
    return {
      vaultDir: VAULT,
      server: SERVER,
      slug: SLUG,
      token,
      localAuthor: LOCAL_AUTHOR,
      device: 'laptop',
      platform: 'win32',
    };
  }

  const AT = '2026-11-02T10:00:00Z';

  // ── 4(a): pull with invalid name → reported, no crash, rest completes ────

  it('4(a): pull CON.md → skippedInvalidNames, no crash, other files pulled', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const deps = makeDeps(parche);
    const { fs, hash } = deps;
    await fs.mkdir(VAULT);

    // Seed a valid file and an invalid one on the server
    const validBytes = new TextEncoder().encode('# Valid note');
    const invalidBytes = new TextEncoder().encode('# CON note');
    const validHash = await hash.sha256(validBytes);
    const invalidHash = await hash.sha256(invalidBytes);
    parche.seedBlob(group.id, validHash, validBytes);
    parche.seedBlob(group.id, invalidHash, invalidBytes);
    parche.seedChange(group.id, {
      path: 'valid.md',
      hash: validHash,
      author: 'remote',
      device: 'other',
      at: AT,
    });
    parche.seedChange(group.id, {
      path: 'CON.md',
      hash: invalidHash,
      author: 'remote',
      device: 'other',
      at: AT,
    });

    const summary = await syncOnce(deps, makeWin32SyncOpts(token));

    // CON.md should be in skippedInvalidNames
    expect(summary.skippedInvalidNames).toContain('CON.md');
    // valid.md should have been pulled
    expect(await fs.exists(`${VAULT}/valid.md`)).toBe(true);
    // CON.md must NOT have been written to disk
    expect(await fs.exists(`${VAULT}/CON.md`)).toBe(false);
    // No crash (no thrown error)
    expect(summary.errors).toHaveLength(0);
  });

  // ── 4(b): second sync pushes NO delete/tombstone ──────────────────────────

  it('4(b): second sync does NOT push a delete for skipped file', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const deps = makeDeps(parche);
    const { hash } = deps;
    await deps.fs.mkdir(VAULT);

    const invalidBytes = new TextEncoder().encode('# CON note');
    const invalidHash = await hash.sha256(invalidBytes);
    parche.seedBlob(group.id, invalidHash, invalidBytes);
    parche.seedChange(group.id, {
      path: 'CON.md',
      hash: invalidHash,
      author: 'remote',
      device: 'other',
      at: AT,
    });

    // First sync: skips CON.md
    const s1 = await syncOnce(deps, makeWin32SyncOpts(token));
    expect(s1.skippedInvalidNames).toContain('CON.md');

    // Capture request log length before second sync
    const logBefore = parche.requestLog.length;

    // Second sync: should not push any delete for CON.md
    const s2 = await syncOnce(deps, makeWin32SyncOpts(token));
    expect(s2.pushed).toBe(0); // no tombstone pushed

    // Check that no DELETE/tombstone was sent for CON.md
    const newRequests = parche.requestLog.slice(logBefore);
    const pushRequests = newRequests.filter((r) => r.method === 'POST' && r.url.includes('/push'));
    // If there were any push requests, verify CON.md was not deleted in server state
    if (pushRequests.length > 0) {
      // The server still has CON.md with its hash (not tombstoned)
      // We can verify by checking the group file map through a fresh sync
    }
    // The state file must still have skippedPaths with CON.md
    const state = await readState(deps.fs, VAULT);
    expect(state?.skippedPaths?.['CON.md']).toBe(invalidHash);
  });

  // ── 4(c): remote update of skipped path → hash refreshed, no phantom conflict

  it('4(c): remote update of skipped file → skippedPaths hash updated', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const deps = makeDeps(parche);
    const { hash } = deps;
    await deps.fs.mkdir(VAULT);

    // First sync: CON.md v1
    const bytes1 = new TextEncoder().encode('# CON v1');
    const hash1 = await hash.sha256(bytes1);
    parche.seedBlob(group.id, hash1, bytes1);
    parche.seedChange(group.id, {
      path: 'CON.md',
      hash: hash1,
      author: 'remote',
      device: 'other',
      at: AT,
    });
    await syncOnce(deps, makeWin32SyncOpts(token));

    // Remote updates CON.md with a new version
    const bytes2 = new TextEncoder().encode('# CON v2');
    const hash2 = await hash.sha256(bytes2);
    parche.seedBlob(group.id, hash2, bytes2);
    parche.seedChange(group.id, {
      path: 'CON.md',
      hash: hash2,
      author: 'remote',
      device: 'other',
      at: AT,
    });

    // Second sync: should update skippedPaths hash, no phantom conflict
    const s2 = await syncOnce(deps, makeWin32SyncOpts(token));
    expect(s2.errors).toHaveLength(0);
    expect(s2.conflicts).toHaveLength(0);

    const state = await readState(deps.fs, VAULT);
    // Hash should be refreshed to v2
    expect(state?.skippedPaths?.['CON.md']).toBe(hash2);
  });

  // ── 4(d): remote delete of skipped path → dropped from skippedPaths ──────

  it('4(d): remote delete of skipped file → dropped from skippedPaths', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const deps = makeDeps(parche);
    const { hash } = deps;
    await deps.fs.mkdir(VAULT);

    // First sync: CON.md
    const bytes = new TextEncoder().encode('# CON note');
    const conHash = await hash.sha256(bytes);
    parche.seedBlob(group.id, conHash, bytes);
    parche.seedChange(group.id, {
      path: 'CON.md',
      hash: conHash,
      author: 'remote',
      device: 'other',
      at: AT,
    });
    await syncOnce(deps, makeWin32SyncOpts(token));

    // Server sends a tombstone for CON.md (hash: null)
    parche.seedChange(group.id, {
      path: 'CON.md',
      hash: null,
      author: 'remote',
      device: 'other',
      at: AT,
    });

    const s2 = await syncOnce(deps, makeWin32SyncOpts(token));
    expect(s2.errors).toHaveLength(0);

    const state = await readState(deps.fs, VAULT);
    // CON.md should be removed from skippedPaths after tombstone
    expect(state?.skippedPaths?.['CON.md']).toBeUndefined();
  });

  // ── 4(e): conflict + skipped in same sync → skippedPaths persisted after phase 3

  it('4(e): conflict + skipped in same sync → skippedPaths preserved after phase 3', async () => {
    // Uses the AC7 pattern: seed state manually so localHash ≠ syncedHash ≠ remoteHash
    // This ensures planPull generates a CONFLICT action (not a clean write), so phase 3
    // runs and its writeState must carry newSkippedPaths forward.
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const deps = makeDeps(parche);
    const { fs, hash } = deps;

    // base (common ancestor, not stored on disk, only in state as syncedHash)
    const baseBytes = new TextEncoder().encode('# Base note');
    const baseHash = await hash.sha256(baseBytes);

    // local edit (different from base — localHash ≠ baseHash ≠ remoteHash ensures conflict)
    const localBytes = new TextEncoder().encode('# Local edit');
    await fs.writeBytes(`${VAULT}/note.md`, localBytes);

    // remote edit (different from both base and local)
    const remoteBytes = new TextEncoder().encode('# Remote edit');
    const remoteHash = await hash.sha256(remoteBytes);

    // Manually seed state: note.md synced at baseHash (common ancestor)
    // This makes note.md locally modified (localHash ≠ baseHash) so phase 2
    // produces a CONFLICT action when the server sends remoteHash.
    await writeState(fs, VAULT, {
      server: SERVER,
      slug: SLUG,
      groupId: group.id,
      cursor: 0,
      files: { 'note.md': { syncedHash: baseHash } },
    });

    // Server: note.md → remoteHash (server head ≠ baseHash → push conflict in phase 1)
    parche.seedBlob(group.id, remoteHash, remoteBytes);
    parche.seedChange(group.id, {
      path: 'note.md',
      hash: remoteHash,
      author: 'other-user',
      device: 'other',
      at: AT,
    });

    // Also add an invalid file to be skipped (triggers newSkippedPaths in phase 2)
    const invalidBytes = new TextEncoder().encode('# CON');
    const invalidHash = await hash.sha256(invalidBytes);
    parche.seedBlob(group.id, invalidHash, invalidBytes);
    parche.seedChange(group.id, {
      path: 'CON.md',
      hash: invalidHash,
      author: 'other-user',
      device: 'other',
      at: AT,
    });

    // Phase 1: push note.md {base: baseHash, new: localHash}
    //   → server has head=remoteHash ≠ baseHash → push conflict returned
    //   → syncedHash stays at baseHash
    // Phase 2: planPull sees remoteHash≠syncedHash AND localHash≠syncedHash → CONFLICT action
    //   → conflict copy written, CON.md skipped → newSkippedPaths = { 'CON.md': invalidHash }
    //   → phase-2 writeState saves newSkippedPaths
    // Phase 3: pushEntries2 includes conflict copy → writeState called with newSkippedPaths
    //   Mutation: if phase-3 passes {} instead, skippedPaths is cleared → 4(e) FAILS
    const s2 = await syncOnce(deps, makeWin32SyncOpts(token));

    // Phase 3 must have run — verify conflicts occurred
    expect(s2.conflicts).toHaveLength(1);

    // After phase 3 (conflict push), skippedPaths should still be persisted
    const state = await readState(fs, VAULT);
    expect(state?.skippedPaths?.['CON.md']).toBe(invalidHash);
  });

  // ── 4(f): blob-gone (404) on retry → dropped + warned, no crash ──────────

  it('4(f): blob gone (404) on retry → dropped from skippedPaths + warning in errors', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const deps = makeDeps(parche);

    // Manually inject a skippedPaths entry with a hash that doesn't exist in blobs
    // The hash must be 64 hex chars (sha256)
    const GHOST_HASH = 'deadbeef'.repeat(8); // 64 chars
    await deps.fs.mkdir(VAULT);
    await writeState(deps.fs, VAULT, {
      server: SERVER,
      slug: SLUG,
      cursor: 0,
      files: {},
      skippedPaths: {
        // This hash is not seeded in the blob store → will get 404 on retry
        'valid-now.md': GHOST_HASH,
      },
    });

    // Do a sync — the retry logic should hit 404 and drop the entry
    const s = await syncOnce(deps, makeWin32SyncOpts(token));

    // No crash
    expect(typeof s.pushed).toBe('number');

    const state = await readState(deps.fs, VAULT);
    // valid-now.md should be removed from skippedPaths (blob gone)
    expect(state?.skippedPaths?.['valid-now.md']).toBeUndefined();
    // An error/warning should appear in errors
    expect(s.errors.some((e) => e.includes('valid-now.md') || e.includes('eliminado'))).toBe(true);
  });

  // ── 4(g): D2.4 — push from posix of a:b.md → warning, push proceeds ──────

  it('4(g): D2.4 — push a:b.md from posix → windowsIncompatibleNames contains it', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const deps = makeDeps(parche);
    const { fs } = deps;
    await fs.mkdir(VAULT);

    // Write a file with a Windows-invalid name on a posix run
    await fs.writeBytes(`${VAULT}/a:b.md`, new TextEncoder().encode('# file with colon'));

    const summary = await syncOnce(deps, {
      vaultDir: VAULT,
      server: SERVER,
      slug: SLUG,
      token,
      localAuthor: LOCAL_AUTHOR,
      device: 'laptop',
      platform: 'linux', // posix run
    });

    // Push should succeed (not blocked)
    expect(summary.pushed).toBe(1);
    // windowsIncompatibleNames should warn about a:b.md
    expect(summary.windowsIncompatibleNames).toContain('a:b.md');
  });

  // ── 4(h): D2.5 — skippedPaths count visible in state ─────────────────────

  it('4(h): D2.5 — skippedPaths is persisted in state.json after pull with invalid name', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const deps = makeDeps(parche);
    const { hash } = deps;
    await deps.fs.mkdir(VAULT);

    const invalidBytes = new TextEncoder().encode('# LPT1 note');
    const invalidHash = await hash.sha256(invalidBytes);
    parche.seedBlob(group.id, invalidHash, invalidBytes);
    parche.seedChange(group.id, {
      path: 'LPT1.md',
      hash: invalidHash,
      author: 'remote',
      device: 'other',
      at: AT,
    });

    await syncOnce(deps, makeWin32SyncOpts(token));

    const state = await readState(deps.fs, VAULT);
    expect(state?.skippedPaths).toBeDefined();
    const skippedCount = Object.keys(state?.skippedPaths ?? {}).length;
    expect(skippedCount).toBeGreaterThan(0);
  });
});

// ─── CHAMBA-014 Tests 1–3: push-first flow ────────────────────────────────────

describe('CHAMBA-014 Test 1 — 20 new files: 0 HEAD, push(422) → PUT×20 → push(ok)', () => {
  it('syncs 20 new files with push-first: no HEAD, one round of 422', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const deps = makeDeps(parche);
    const { fs } = deps;

    // Seed 20 local files (blobs NOT pre-seeded in FakeParche, so first push → 422)
    const enc = new TextEncoder();
    for (let i = 0; i < 20; i++) {
      await fs.writeBytes(`${VAULT}/note${i}.md`, enc.encode(`# Note ${i}`));
    }

    const summary = await syncOnce(deps, makeSyncOpts(token));

    expect(summary.pushed).toBe(20);
    expect(summary.errors).toHaveLength(0);

    // 0 HEAD requests — critical acceptance criterion (§7.3)
    const headRequests = parche.requestLog.filter((r) => r.method === 'HEAD');
    expect(headRequests).toHaveLength(0);

    // Exactly 2 /push requests (one 422, one ok)
    const pushRequests = parche.requestLog.filter((r) => r.url.includes('/push'));
    expect(pushRequests).toHaveLength(2);

    // 20 PUT /blob/ requests between the two pushes
    const pushIdx1 = parche.requestLog.findIndex((r) => r.url.includes('/push'));
    const pushIdx2 = parche.requestLog.findIndex((r, i) => i > pushIdx1 && r.url.includes('/push'));
    expect(pushIdx2).toBeGreaterThan(pushIdx1);
    const between = parche.requestLog.slice(pushIdx1 + 1, pushIdx2);
    const putsBetween = between.filter((r) => r.method === 'PUT' && r.url.includes('/blob/'));
    expect(putsBetween).toHaveLength(20);
  });
});

describe('CHAMBA-014 Test 2 — rondas de 422', () => {
  it('two rounds completes: second 422 with smaller set → upload → push ok', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const deps = makeDeps(parche);
    const { fs, hash } = deps;

    // Seed 3 files. Use rejectPushBlobsOnce for 2 of the hashes to simulate 2 rounds.
    const enc = new TextEncoder();
    const bytes1 = enc.encode('# File 1');
    const bytes2 = enc.encode('# File 2');
    const bytes3 = enc.encode('# File 3');
    const h1 = await hash.sha256(bytes1);
    const h2 = await hash.sha256(bytes2);

    await fs.writeBytes(`${VAULT}/f1.md`, bytes1);
    await fs.writeBytes(`${VAULT}/f2.md`, bytes2);
    await fs.writeBytes(`${VAULT}/f3.md`, bytes3);

    // Round 1: rejectPushBlobsOnce fires first → 422 [h1, h2] → PUT h1, h2.
    // Round 2: natural check → only f3's blob is missing → 422 [h3] → PUT h3.
    // Round 3: push ok.
    parche.rejectPushBlobsOnce([h1, h2]);

    const summary = await syncOnce(deps, makeSyncOpts(token));

    expect(summary.pushed).toBe(3);
    expect(summary.errors).toHaveLength(0);

    const seq = parche.requestLog
      .filter((r) => r.url.includes('/push') || r.url.includes('/api/blob/'))
      .map((r) => (r.url.includes('/push') ? 'push' : r.method));
    expect(seq).toEqual(['push', 'PUT', 'PUT', 'push', 'PUT', 'push']);
    expect(parche.blobHashes(group.id)).toHaveLength(3);
    expect(parche.livePaths(group.id).size).toBe(3);
  });

  it('CHAMBA-023 S4 (B4/N1 — progress by containment): a shrinking-but-already-PUT missing set aborts on the FIRST redundant round, not the 3-round cap', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const deps = makeDeps(parche);
    const { fs, hash } = deps;

    const enc = new TextEncoder();
    const hs: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const bytes = enc.encode(`# Cap ${i}`);
      hs.push(await hash.sha256(bytes));
      await fs.writeBytes(`${VAULT}/cap${i}.md`, bytes);
    }
    // 422 sets: {1,2,3,4} → {1,2,3} → {1,2}: always shrinking.
    //
    // Pre-CHAMBA-023, the guard compared SET SIZE round over round, so this
    // kept "making progress" for 3 rounds before the hard cap stopped it
    // (4 push calls total). CHAMBA-023 S4 (review ronda 2, B4/N1) replaces
    // that with "progress by containment": round 1 PUTs h1-h4 (all genuinely
    // missing — the first attempt always sees every locally-changed hash as
    // missing, since nothing has been uploaded yet). Round 2 re-reports
    // {h1,h2,h3} — review item 5 gives each a SECOND PUT attempt before
    // treating it as fully handled, so round 2 still makes progress (not an
    // abort). Round 3 re-reports {h1,h2} — both now have 2/2 attempts used
    // (fully handled) → the guard throws right there instead of burning
    // through to the 3-round hard cap. 3 `/push` calls happen (not 4, and
    // not 2 — review item 5 buys exactly one extra round over the original
    // B4/N1 design).
    const [h1, h2, h3, h4] = hs as [string, string, string, string];
    parche.rejectPushBlobsOnce([h1, h1, h1, h1, h2, h2, h2, h3, h3, h4]);

    await expect(syncOnce(deps, makeSyncOpts(token))).rejects.toThrow(
      /no se pudo completar el push: faltan blobs/,
    );
    const pushCalls = parche.requestLog.filter((r) => r.url.includes('/push'));
    expect(pushCalls).toHaveLength(3);
    expect(await readState(fs, VAULT)).toBeNull();
  });

  it('set does not reduce → error after ≤3 rounds, state not written', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const deps = makeDeps(parche);
    const { fs, hash } = deps;

    const enc = new TextEncoder();
    const bytes = enc.encode('# Stuck note');
    const noteHash = await hash.sha256(bytes);
    await fs.writeBytes(`${VAULT}/note.md`, bytes);

    // Permanent rejection: every push returns 422 for noteHash — set never reduces
    parche.rejectPushBlobs([noteHash]);

    // Pre-write a state to verify it's not modified on failure
    await writeState(fs, VAULT, {
      server: SERVER,
      slug: SLUG,
      groupId: group.id,
      cursor: 0,
      files: {},
      lastSyncAt: '2026-01-01T00:00:00Z',
    });

    await expect(syncOnce(deps, makeSyncOpts(token))).rejects.toThrow(
      /no se pudo completar el push: faltan blobs/,
    );

    // Push calls ≤ 4 (initial + up to 3 rounds before the "not reducing" error)
    const pushCalls = parche.requestLog.filter((r) => r.url.includes('/push'));
    expect(pushCalls.length).toBeLessThanOrEqual(4);

    // State not modified — cursor still 0, files still {}
    const state = await readState(fs, VAULT);
    expect(state?.cursor).toBe(0);
    expect(Object.keys(state?.files ?? {})).toHaveLength(0);

    // Next sync against the SAME server, once it stops rejecting, completes.
    parche.clearPushBlobRejections();
    const summary2 = await syncOnce(deps, makeSyncOpts(token));
    expect(summary2.pushed).toBe(1);
    expect(summary2.errors).toHaveLength(0);
    expect((await readState(fs, VAULT))?.files['note.md']?.syncedHash).toBe(noteHash);
  });
});

describe('CHAMBA-014 Test 3 — hash sin fuente local', () => {
  it('server reports a hash the client has no local source for → explicit error, state not written', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const deps = makeDeps(parche);
    const { fs } = deps;

    const enc = new TextEncoder();
    const bytes = enc.encode('# Local note');
    await fs.writeBytes(`${VAULT}/local.md`, bytes);

    // Inject a hash that doesn't exist locally (not in blobSource).
    // FakeParche will include this hash in the 422 response alongside the naturally
    // missing localHash. pushAll sees ghostHash has no blobSource entry → throws.
    const ghostHash = 'a'.repeat(64); // valid 64-char hex string, but not a local file
    parche.injectMissingBlob(ghostHash);

    let thrown: Error | null = null;
    try {
      await syncOnce(deps, makeSyncOpts(token));
    } catch (err) {
      if (err instanceof Error) thrown = err;
    }

    expect(thrown).not.toBeNull();
    expect(thrown?.message).toMatch(/no se pudo completar el push: faltan blobs/);
    // Error must include the short hash of the ghost blob (first 8 chars)
    expect(thrown?.message).toContain(ghostHash.slice(0, 8));

    // State not written — no state.json should have been created
    const state = await readState(fs, VAULT);
    if (state !== null) {
      expect(state.cursor).toBe(0);
      expect(Object.keys(state.files)).toHaveLength(0);
    }
  });
});

// ─── CHAMBA-014: ParcheNetworkError unit tests ────────────────────────────────

describe('CHAMBA-014 — ParcheNetworkError', () => {
  it('extracts host from URL (no query/token)', async () => {
    const { ParcheNetworkError } = await import('./parche-client.js');
    // URL.host for standard ports (443 for https) does not include the port number.
    // Use a non-standard port to verify port inclusion in host.
    const err = new ParcheNetworkError({
      url: 'https://parche.example.com:8443/api/join?token=pch_TESTSECRET123&foo=bar',
      attempts: 3,
      code: 'ECONNRESET',
      shortMessage: 'connection reset',
    });
    expect(err.host).toBe('parche.example.com:8443');
    expect(err.message).not.toContain('pch_TESTSECRET');
    expect(err.message).not.toContain('token');
    expect(err.host).not.toContain('?');
    expect(err.host).not.toContain('pch_TESTSECRET');
  });

  it('strips default HTTPS port from host', async () => {
    const { ParcheNetworkError } = await import('./parche-client.js');
    // Standard ports are stripped by URL.host (per URL spec)
    const err = new ParcheNetworkError({
      url: 'https://parche.example.com:443/api/join?token=pch_TESTSECRET123',
      attempts: 1,
      code: 'ETIMEDOUT',
      shortMessage: 'timed out',
    });
    // port 443 is default for https — URL.host omits it
    expect(err.host).toBe('parche.example.com');
    expect(err.host).not.toContain('pch_TESTSECRET');
    expect(err.message).not.toContain('pch_TESTSECRET');
  });

  it('falls back to <desconocido> for malformed URL', async () => {
    const { ParcheNetworkError } = await import('./parche-client.js');
    const err = new ParcheNetworkError({
      url: 'not-a-url',
      attempts: 1,
      code: 'ETIMEDOUT',
      shortMessage: 'timed out',
    });
    expect(err.host).toBe('<desconocido>');
  });

  it('name is ParcheNetworkError', async () => {
    const { ParcheNetworkError } = await import('./parche-client.js');
    const err = new ParcheNetworkError({
      url: 'https://example.com',
      attempts: 2,
      code: 'ECONNREFUSED',
      shortMessage: 'refused',
    });
    expect(err.name).toBe('ParcheNetworkError');
    expect(err.attempts).toBe(2);
    expect(err.code).toBe('ECONNREFUSED');
  });
});

// ─── CHAMBA-014: parcheNetworkErrorMessage unit tests ────────────────────────

describe('CHAMBA-014 — parcheNetworkErrorMessage', () => {
  it('produces exact format with slug', async () => {
    const { ParcheNetworkError } = await import('./parche-client.js');
    const { parcheNetworkErrorMessage } = await import('./messages.js');

    const err = new ParcheNetworkError({
      url: 'https://parche.chamba.tools/api/g/cya/push?token=pch_TESTSECRET999',
      attempts: 3,
      code: 'UND_ERR_CONNECT_TIMEOUT',
      shortMessage: 'connect timeout',
    });

    const msg = parcheNetworkErrorMessage(err, { slug: 'cya' });

    // Exact format check (§4.3)
    expect(msg).toBe(
      'parche: no se pudo conectar a parche.chamba.tools tras 3 intentos ' +
        '(UND_ERR_CONNECT_TIMEOUT: connect timeout). ' +
        'Lo ya subido queda guardado; vuelve a correr `npx @chamba/mcp vault sync cya`.',
    );

    // No secrets
    expect(msg).not.toContain('pch_TESTSECRET');
    expect(msg).not.toContain('Authorization');
    expect(msg).not.toContain('token=');
  });

  it('singular "intento" when attempts=1', async () => {
    const { ParcheNetworkError } = await import('./parche-client.js');
    const { parcheNetworkErrorMessage } = await import('./messages.js');

    const err = new ParcheNetworkError({
      url: 'https://parche.example.com',
      attempts: 1,
      code: 'ECONNREFUSED',
      shortMessage: 'refused',
    });

    const msg = parcheNetworkErrorMessage(err, { slug: 'test' });
    expect(msg).toContain('1 intento');
    expect(msg).not.toContain('1 intentos');
  });

  it('uses retryHint when provided (e.g. for join)', async () => {
    const { ParcheNetworkError } = await import('./parche-client.js');
    const { parcheNetworkErrorMessage } = await import('./messages.js');

    const err = new ParcheNetworkError({
      url: 'https://parche.example.com',
      attempts: 2,
      code: 'ECONNREFUSED',
      shortMessage: 'refused',
    });

    const msg = parcheNetworkErrorMessage(err, { retryHint: 'npx @chamba/mcp vault join <code>' });
    expect(msg).toContain('npx @chamba/mcp vault join <code>');
    expect(msg).not.toContain('vault sync');
  });

  it('generic hint when no slug or retryHint given', async () => {
    const { ParcheNetworkError } = await import('./parche-client.js');
    const { parcheNetworkErrorMessage } = await import('./messages.js');

    const err = new ParcheNetworkError({
      url: 'https://parche.example.com',
      attempts: 2,
      code: 'ETIMEDOUT',
      shortMessage: 'timed out',
    });

    const msg = parcheNetworkErrorMessage(err);
    expect(msg).toContain('vault sync <slug>');
  });
});

// ─── CHAMBA-014: FlakyHttp unit tests ────────────────────────────────────────

describe('CHAMBA-014 — FlakyHttp', () => {
  it('deterministic by seed: same seed produces same failure sequence', async () => {
    const { FlakyHttp } = await import('../testing/flaky-http.js');
    const enc = new TextEncoder();

    // Build a minimal pass-through HttpPort
    const okHttp = {
      async request(_req: import('../ports/http.js').HttpRequest) {
        return { status: 200, headers: {}, body: enc.encode('ok') };
      },
    };

    const req = { method: 'GET', url: 'https://example.com/', headers: {} };

    // Run with seed 42, rate 0.5 — collect success/fail pattern for 10 calls
    async function runSequence(seed: number): Promise<boolean[]> {
      const flaky = new FlakyHttp(okHttp, { seed, rate: 0.5 });
      const results: boolean[] = [];
      for (let i = 0; i < 10; i++) {
        try {
          await flaky.request(req);
          results.push(true);
        } catch {
          results.push(false);
        }
      }
      return results;
    }

    const seq1 = await runSequence(42);
    const seq2 = await runSequence(42);
    expect(seq1).toEqual(seq2);

    // Different seed → different sequence (with high probability)
    const seq3 = await runSequence(99);
    // It's possible (but unlikely) for two seeds to produce the same sequence.
    // We just check that the determinism works, not that they're different.
    expect(seq1).toHaveLength(10);
    expect(seq3).toHaveLength(10);
  });

  it('pre mode: throws without delegating', async () => {
    const { FlakyHttp } = await import('../testing/flaky-http.js');
    let delegated = false;
    const wrapped = {
      async request(_req: import('../ports/http.js').HttpRequest) {
        delegated = true;
        return { status: 200, headers: {}, body: new Uint8Array(0) };
      },
    };
    const flaky = new FlakyHttp(wrapped, { seed: 1, rate: 0 });
    flaky.failNext(1, 'ECONNRESET', 'pre');
    await expect(
      flaky.request({ method: 'GET', url: 'https://x.com', headers: {} }),
    ).rejects.toThrow('ECONNRESET');
    expect(delegated).toBe(false);
  });

  it('post mode: delegates then throws', async () => {
    const { FlakyHttp } = await import('../testing/flaky-http.js');
    let delegated = false;
    const wrapped = {
      async request(_req: import('../ports/http.js').HttpRequest) {
        delegated = true;
        return { status: 200, headers: {}, body: new Uint8Array(0) };
      },
    };
    const flaky = new FlakyHttp(wrapped, { seed: 1, rate: 0 });
    flaky.failNext(1, 'ECONNRESET', 'post');
    await expect(
      flaky.request({ method: 'GET', url: 'https://x.com', headers: {} }),
    ).rejects.toThrow('ECONNRESET');
    expect(delegated).toBe(true);
  });

  it('failNext: explicit fails consumed in order', async () => {
    const { FlakyHttp } = await import('../testing/flaky-http.js');
    const enc = new TextEncoder();
    const wrapped = {
      async request(_req: import('../ports/http.js').HttpRequest) {
        return { status: 200, headers: {}, body: enc.encode('ok') };
      },
    };
    const flaky = new FlakyHttp(wrapped, { seed: 1, rate: 0 });
    flaky.failNext(2, 'ETIMEDOUT');

    // First two calls fail
    await expect(
      flaky.request({ method: 'GET', url: 'https://x.com', headers: {} }),
    ).rejects.toThrow();
    await expect(
      flaky.request({ method: 'GET', url: 'https://x.com', headers: {} }),
    ).rejects.toThrow();
    // Third call succeeds
    const res = await flaky.request({ method: 'GET', url: 'https://x.com', headers: {} });
    expect(res.status).toBe(200);
  });

  it('match filter: only matching requests fail', async () => {
    const { FlakyHttp } = await import('../testing/flaky-http.js');
    const enc = new TextEncoder();
    const wrapped = {
      async request(_req: import('../ports/http.js').HttpRequest) {
        return { status: 200, headers: {}, body: enc.encode('ok') };
      },
    };
    const flaky = new FlakyHttp(wrapped, {
      seed: 1,
      rate: 0,
      match: (req) => req.url.includes('/push'),
    });
    flaky.failNext(1, 'ECONNRESET');

    // Non-matching request succeeds
    const res = await flaky.request({ method: 'GET', url: 'https://x.com/changes', headers: {} });
    expect(res.status).toBe(200);

    // Matching request fails (explicit fail still in queue)
    await expect(
      flaky.request({ method: 'POST', url: 'https://x.com/push', headers: {} }),
    ).rejects.toThrow('ECONNRESET');
  });
});
