/**
 * runner-secret-gate.test.ts — CHAMBA-021 S6 integration tests: `syncOnce`
 * wired to the secret gate (phases 1 and 3), `state.blockedSecret`, and the
 * allowlist. Kept as its own file (rather than appending to the already
 * large runner.test.ts) per the implementer's own judgment call.
 */
import { describe, expect, it } from 'vitest';
import type { ClockPort } from '../ports/clock.js';
import { addSecretAllowEntry } from '../secrets/allowlist.js';
import { FakeHash } from '../testing/fake-hash.js';
import { FakeParche } from '../testing/fake-parche.js';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { syncOnce } from './runner.js';
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
  return { fs: new MemoryFilesystem(), http: parche, hash: new FakeHash(), clock: makeClock() };
}

function setupGroup(parche: FakeParche) {
  const group = parche.seedGroup({ slug: SLUG, name: 'Test Group' });
  parche.addInvite({ code: 'ABCD-1234', groupId: group.id, role: 'editor' });
  return group;
}

function makeSyncOpts(
  token: string,
  overrides: Partial<Parameters<typeof syncOnce>[1]> = {},
): Parameters<typeof syncOnce>[1] {
  return {
    vaultDir: VAULT,
    server: SERVER,
    slug: SLUG,
    token,
    localAuthor: LOCAL_AUTHOR,
    device: 'laptop',
    ...overrides,
  };
}

const SECRET_LINE = () => `token: ${'pch_'}${'A'.repeat(24)}\n`;

describe('CHAMBA-021 S6 — syncOnce secret gate', () => {
  it('3 files, one with a secret → 2 pushed, 1 blocked and recorded in state', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop', role: 'editor' });
    const deps = makeDeps(parche);

    await deps.fs.writeBytes(`${VAULT}/a.md`, new TextEncoder().encode('# A\n'));
    await deps.fs.writeBytes(`${VAULT}/b.md`, new TextEncoder().encode('# B\n'));
    await deps.fs.writeBytes(`${VAULT}/secret.md`, new TextEncoder().encode(SECRET_LINE()));

    const summary = await syncOnce(deps, makeSyncOpts(token));

    expect(summary.pushed).toBe(2);
    expect(summary.blockedBySecret?.map((f) => f.path)).toEqual(['secret.md']);

    const state = await readState(deps.fs, VAULT);
    expect(Object.keys(state?.blockedSecret ?? {})).toEqual(['secret.md']);
    expect(state?.files['secret.md']).toBeUndefined();
  });

  it('after removing the secret value, the next sync uploads it and clears blockedSecret', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop', role: 'editor' });
    const deps = makeDeps(parche);

    await deps.fs.writeBytes(`${VAULT}/secret.md`, new TextEncoder().encode(SECRET_LINE()));
    const summary1 = await syncOnce(deps, makeSyncOpts(token));
    expect(summary1.pushed).toBe(0);

    await deps.fs.writeBytes(`${VAULT}/secret.md`, new TextEncoder().encode('# now clean\n'));
    const summary2 = await syncOnce(deps, makeSyncOpts(token));
    expect(summary2.pushed).toBe(1);
    expect(summary2.blockedBySecret ?? []).toEqual([]);

    const state = await readState(deps.fs, VAULT);
    expect(state?.blockedSecret ?? {}).toEqual({});
  });

  it('with the fingerprint allowlisted, the file uploads without being modified', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop', role: 'editor' });
    const deps = makeDeps(parche);

    const body = SECRET_LINE();
    await deps.fs.writeBytes(`${VAULT}/secret.md`, new TextEncoder().encode(body));
    const blocked1 = await syncOnce(deps, makeSyncOpts(token));
    const finding = blocked1.blockedBySecret?.[0];
    expect(finding).toBeDefined();

    await addSecretAllowEntry(deps.fs, makeClock(), VAULT, {
      path: 'secret.md',
      fingerprint: finding?.fingerprint ?? '',
    });

    const summary2 = await syncOnce(deps, makeSyncOpts(token));
    expect(summary2.pushed).toBe(1);
    expect(summary2.blockedBySecret ?? []).toEqual([]);

    // The file on disk is byte-identical — allowlisting never rewrites content.
    const after = await deps.fs.readFile(`${VAULT}/secret.md`);
    expect(after).toBe(body);
  });

  it('a tombstone (delete) of a file that had a secret is still pushed', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop', role: 'editor' });
    const deps = makeDeps(parche);

    // 1. Push the file clean — it becomes known to the server (synced).
    await deps.fs.writeBytes(`${VAULT}/secret.md`, new TextEncoder().encode('# clean\n'));
    const summary1 = await syncOnce(deps, makeSyncOpts(token));
    expect(summary1.pushed).toBe(1);

    // 2. A secret gets added locally — the update is blocked (server still has the clean version).
    await deps.fs.writeBytes(`${VAULT}/secret.md`, new TextEncoder().encode(SECRET_LINE()));
    const summary2 = await syncOnce(deps, makeSyncOpts(token));
    expect(summary2.pushed).toBe(0);
    expect(summary2.blockedBySecret?.map((f) => f.path)).toEqual(['secret.md']);

    // 3. Deleting the local file produces a tombstone — it must upload regardless
    // (tombstones are never counted in `pushed`, same as before this gate existed —
    // see runner.test.ts "no tombstone pushed" for non-secret deletes).
    await deps.fs.remove(`${VAULT}/secret.md`);
    const summary3 = await syncOnce(deps, makeSyncOpts(token));
    expect(summary3.blockedBySecret ?? []).toEqual([]);
    const state = await readState(deps.fs, VAULT);
    expect(state?.blockedSecret ?? {}).toEqual({});
    // The tombstone reached the server: syncing again finds nothing more to do.
    const summary4 = await syncOnce(deps, makeSyncOpts(token));
    expect(summary4.pushed).toBe(0);
    expect(summary4.pulled).toBe(0);
  });

  it('the secret gate does not depend on the path separator style (win32 matrix)', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop', role: 'editor' });
    const deps = makeDeps(parche);

    await deps.fs.writeBytes(`${VAULT}/carpeta/secret.md`, new TextEncoder().encode(SECRET_LINE()));
    const summary = await syncOnce(deps, makeSyncOpts(token, { platform: 'win32' }));
    expect(summary.pushed).toBe(0);
    expect(summary.blockedBySecret?.map((f) => f.path)).toEqual(['carpeta/secret.md']);
  });
});
