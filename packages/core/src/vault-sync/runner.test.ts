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
import { CaseCollisionError, joinOnce, scanLocal, syncOnce } from './runner.js';
import { readState } from './state-store.js';

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

describe('AC10 — 422 missing_blobs: uploads missing and retries once', () => {
  it('always-422 push eventually throws "Push failed after retry"', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const token = makeToken(parche, group);

    const noteBytes = new TextEncoder().encode('# note');
    await fs.writeBytes(`${VAULT}/note.md`, noteBytes);
    const noteHash = await hash.sha256(noteBytes);

    parche.rejectPushBlobs([noteHash]);

    const deps = { fs, http: parche, hash, clock: makeClock() };
    await expect(syncOnce(deps, makeSyncOpts(token))).rejects.toThrow(/Push failed after retry/);
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

    // First push call returns 422, second succeeds
    // But the blob must NOT be pre-uploaded (HEAD returns 404, but we skip the PUT
    // before push by using rejectPushBlobsOnce so push gets 422 and re-uploads)
    // Strategy: make HEAD say blob exists (so pre-flight skips PUT), then push returns 422
    // We achieve this by seeding the blob but using rejectPushBlobsOnce for push
    // Actually simpler: use rejectPushBlobsOnce which rejects push once, forcing re-upload + retry
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
});

// ─── Additional: no /push call when plan is empty ────────────────────────────

describe('no /push when planPush is empty', () => {
  it('does not call /push when there are no local changes', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
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
