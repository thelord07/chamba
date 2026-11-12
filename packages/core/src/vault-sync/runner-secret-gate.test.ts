/**
 * runner-secret-gate.test.ts — CHAMBA-021 S6 integration tests: `syncOnce`
 * wired to the secret gate (phases 1 and 3), `state.blockedSecret`, and the
 * allowlist. Kept as its own file (rather than appending to the already
 * large runner.test.ts) per the implementer's own judgment call.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ClockPort } from '../ports/clock.js';
import { addSecretAllowEntry } from '../secrets/allowlist.js';
import { FakeHash } from '../testing/fake-hash.js';
import { FakeParche } from '../testing/fake-parche.js';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { addConflictFrontmatter } from './conflict.js';
import { joinOnce, syncOnce } from './runner.js';
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

// ─── CHAMBA-023 D-Q3: scanLocal's precompute avoids a 2nd read for the scan ──

describe('CHAMBA-023 D-Q3 — scanLocal precompute (reuses the hash-read bytes, no extra read)', () => {
  it('a changed .md file is read exactly twice by fs.readBytes: scanLocal (hash+scan merged) and pushAll (the PUT body) — never 3 times', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop', role: 'editor' });
    const deps = makeDeps(parche);

    await deps.fs.writeBytes(`${VAULT}/note.md`, new TextEncoder().encode('# hello\n'));
    const readBytesSpy = vi.spyOn(deps.fs, 'readBytes');

    const summary = await syncOnce(deps, makeSyncOpts(token));
    expect(summary.pushed).toBe(1);

    // scanLocal reads the bytes once to compute the hash AND scan for secrets
    // in the same pass (CHAMBA-023 D-Q3); pushAll reads them again separately
    // to build the PUT request body (the network upload, unrelated to
    // scanning — this read always existed, pre- and post-D-Q3). Before D-Q3
    // this path would read the file a 3RD time inside `screenPushEntries`
    // (`fs.readFile`, to decode and scan); that read is gone.
    const noteReads = readBytesSpy.mock.calls.filter(([p]) => p === `${VAULT}/note.md`).length;
    expect(noteReads).toBe(2);
  });

  it('a secret-bearing .md file is read exactly once (blocked before pushAll ever touches it, so no PUT-body read either)', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop', role: 'editor' });
    const deps = makeDeps(parche);

    await deps.fs.writeBytes(`${VAULT}/secret.md`, new TextEncoder().encode(SECRET_LINE()));
    const readBytesSpy = vi.spyOn(deps.fs, 'readBytes');

    const summary = await syncOnce(deps, makeSyncOpts(token));
    expect(summary.pushed).toBe(0);
    expect(summary.blockedBySecret?.map((f) => f.path)).toEqual(['secret.md']);

    // Blocked entries never reach pushAll, so there's no PUT-body read either
    // — scanLocal's single hash+scan read is the only one (precompute means
    // `screenPushEntries` never re-reads it to discover the same finding).
    const secretReads = readBytesSpy.mock.calls.filter((c) => c[0] === `${VAULT}/secret.md`).length;
    expect(secretReads).toBe(1);
  });

  it('an unchanged file (same syncedHash as the previous sync) is not rescanned on the 2nd sync', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop', role: 'editor' });
    const deps = makeDeps(parche);

    await deps.fs.writeBytes(`${VAULT}/note.md`, new TextEncoder().encode('# hello\n'));
    const summary1 = await syncOnce(deps, makeSyncOpts(token));
    expect(summary1.pushed).toBe(1);

    // 2nd sync: nothing changed locally — note.md is still read once (scanLocal
    // must still hash every local file to build the snapshot), but it must NOT
    // be scanned again (no entry in findingsByPath — see scanLocal unit tests),
    // and the sync overall sees nothing new to push.
    const readBytesSpy = vi.spyOn(deps.fs, 'readBytes');
    const summary2 = await syncOnce(deps, makeSyncOpts(token));
    expect(summary2.pushed).toBe(0);
    expect(summary2.blockedBySecret ?? []).toEqual([]);

    const noteReads = readBytesSpy.mock.calls.filter((c) => c[0] === `${VAULT}/note.md`).length;
    expect(noteReads).toBe(1); // only the hash read — no second read for scanning
  });

  it('phase 3 (conflict copy): a fresh copy is scanned via the phase-3 scanLocal precompute, blocked if it has a secret', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const u1 = parche.addDevice(group.id, { userId: 'u1', label: 'laptop', role: 'editor' });
    const deps = makeDeps(parche);

    // Seed a remote change so pulling it produces a conflict against our local edit.
    const enc = new TextEncoder();
    const remoteBytes = enc.encode('# remote version\n');
    const remoteHash = await deps.hash.sha256(remoteBytes);
    parche.seedBlob(group.id, remoteHash, remoteBytes);
    parche.seedChange(group.id, {
      path: 'note.md',
      hash: remoteHash,
      author: 'other',
      device: 'their-device',
      at: '2026-10-29T10:00:00Z',
    });

    // Local, DIFFERENT content with a secret → conflict copy will carry the secret.
    await deps.fs.writeBytes(`${VAULT}/note.md`, enc.encode(SECRET_LINE()));

    const summary = await syncOnce(deps, makeSyncOpts(u1));
    // The conflict copy (phase 3) must be blocked for the same reason as a
    // normal push — the local gate covers conflict copies too (CHAMBA-021),
    // now wired through the phase-3 scanLocal precompute (CHAMBA-023 D-Q3).
    expect(summary.conflicts.length).toBe(1);
    expect(summary.blockedBySecret?.length ?? 0).toBeGreaterThan(0);
  });
});

// ─── CHAMBA-023 S7 — integration tests over syncOnce + FakeParche (REAL knobs,
// no spies): header scoping (X-Parche-Secret-Allow), server 422 handling,
// D-Q1(b)/B3 hash+allowDigest lifecycle, B3/B4 push termination, phase 3,
// adoption, the seed fixture, and D-Q3 (content-based scanning for non-.md
// syncable files). An earlier version of this coverage used
// `vi.spyOn(parche, 'request')` in a separate file, written before these
// FakeParche knobs existed; that file was removed once these real-knob
// tests fully superseded it (review items 12-14). ───────────────────────────

// Secret-shaped values are built from a template with a computed segment,
// never as a literal string, so no real-looking secret sits in this source file.
const TOK = (suffix: string) => `token: pch_${suffix.repeat(24)}\n`;

function setupS7(): {
  parche: FakeParche;
  group: ReturnType<typeof setupGroup>;
  token: string;
  deps: { fs: MemoryFilesystem; http: FakeParche; hash: FakeHash; clock: ClockPort };
} {
  const parche = new FakeParche(makeClock());
  const group = setupGroup(parche);
  const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop', role: 'editor' });
  const fs = new MemoryFilesystem();
  return {
    parche,
    group,
    token,
    deps: { fs, http: parche, hash: new FakeHash(), clock: makeClock() },
  };
}

describe('CHAMBA-023 S7.1-3 — X-Parche-Secret-Allow header scoping (real FakeParche knobs)', () => {
  it('S7.1 — two notes, each with its OWN exempted secret: each PUT carries ONLY its own fingerprint', async () => {
    const { parche, token, deps } = setupS7();
    const enc = new TextEncoder();

    const bodyA = `# Note A\n${TOK('A')}`;
    const bodyB = `# Note B\n${TOK('B')}`;
    await deps.fs.writeBytes(`${VAULT}/noteA.md`, enc.encode(bodyA));
    await deps.fs.writeBytes(`${VAULT}/noteB.md`, enc.encode(bodyB));

    const blocked1 = await syncOnce(deps, makeSyncOpts(token));
    expect(blocked1.pushed).toBe(0);
    const fpA = blocked1.blockedBySecret?.find((f) => f.path === 'noteA.md')?.fingerprint;
    const fpB = blocked1.blockedBySecret?.find((f) => f.path === 'noteB.md')?.fingerprint;
    expect(fpA).toBeDefined();
    expect(fpB).toBeDefined();
    expect(fpA).not.toBe(fpB);

    await addSecretAllowEntry(deps.fs, makeClock(), VAULT, {
      path: 'noteA.md',
      fingerprint: fpA ?? '',
    });
    await addSecretAllowEntry(deps.fs, makeClock(), VAULT, {
      path: 'noteB.md',
      fingerprint: fpB ?? '',
    });

    const summary2 = await syncOnce(deps, makeSyncOpts(token));
    expect(summary2.pushed).toBe(2);
    expect(summary2.blockedBySecret ?? []).toEqual([]);

    const hashA = await deps.hash.sha256(enc.encode(bodyA));
    const hashB = await deps.hash.sha256(enc.encode(bodyB));
    expect(parche.blobAllowHeaders.get(hashA)).toEqual([fpA]);
    expect(parche.blobAllowHeaders.get(hashB)).toEqual([fpB]);
  });

  it('S7.2 — a file with no findings: PUT carries no X-Parche-Secret-Allow header at all', async () => {
    const { parche, token, deps } = setupS7();
    const enc = new TextEncoder();
    const body = '# Plain note, nothing secret here\n';
    await deps.fs.writeBytes(`${VAULT}/plain.md`, enc.encode(body));

    const summary = await syncOnce(deps, makeSyncOpts(token));
    expect(summary.pushed).toBe(1);

    const hash = await deps.hash.sha256(enc.encode(body));
    expect(parche.blobAllowHeaders.get(hash)).toEqual([]);
  });

  it('S7.3 — a fingerprint exempted for ANOTHER path is neither sent nor does it unblock this one', async () => {
    const { parche, token, deps } = setupS7();
    const enc = new TextEncoder();

    // Same secret VALUE (same fingerprint) in two different files/content.
    const bodyExempt = `# Exempt path\n${TOK('C')}`;
    const bodyOther = `# Other path, same secret value\n${TOK('C')}`;
    await deps.fs.writeBytes(`${VAULT}/exempt.md`, enc.encode(bodyExempt));

    const blocked1 = await syncOnce(deps, makeSyncOpts(token));
    const fp = blocked1.blockedBySecret?.find((f) => f.path === 'exempt.md')?.fingerprint;
    expect(fp).toBeDefined();

    // Exempt ONLY exempt.md — never other.md.
    await addSecretAllowEntry(deps.fs, makeClock(), VAULT, {
      path: 'exempt.md',
      fingerprint: fp ?? '',
    });
    await deps.fs.writeBytes(`${VAULT}/other.md`, enc.encode(bodyOther));

    const summary2 = await syncOnce(deps, makeSyncOpts(token));
    expect(summary2.pushed).toBe(1); // only exempt.md
    expect(summary2.blockedBySecret?.map((f) => f.path)).toEqual(['other.md']);

    const hashExempt = await deps.hash.sha256(enc.encode(bodyExempt));
    expect(parche.blobAllowHeaders.get(hashExempt)).toEqual([fp]);
    // other.md never reached pushAll/putBlob — no PUT request for its hash at all.
    const hashOther = await deps.hash.sha256(enc.encode(bodyOther));
    const putsForOther = parche.requestLog.filter(
      (r) => r.method === 'PUT' && r.url.endsWith(`/blob/${hashOther}`),
    );
    expect(putsForOther).toHaveLength(0);
  });
});

describe('CHAMBA-023 S7.4/7 — server 422 secret_detected (real knobs: rejectBlobAsSecret)', () => {
  it('S7.4 — 422 on 1 of 3 files → pushed 2, the 3rd in blockedBySecretServer, sync ends OK, NO SECRET VALUE LEAKS', async () => {
    const { parche, token, deps } = setupS7();
    const enc = new TextEncoder();

    // A plausible secret-shaped value the LOCAL scanner does NOT recognize
    // (no `key: value`/`key=value` syntax, no known provider prefix) — models
    // the version-skew scenario (plan §4): the server's rules caught something
    // the client's older scanner missed.
    const secretValue = 'QzR5VGhpc0lzTm90QVJlYWxTZWNyZXQxMjM0NTY3ODk=';
    const cBody = `# C\nreferencia: ${secretValue}\n`;
    await deps.fs.writeBytes(`${VAULT}/a.md`, enc.encode('# A\n'));
    await deps.fs.writeBytes(`${VAULT}/b.md`, enc.encode('# B\n'));
    await deps.fs.writeBytes(`${VAULT}/c.md`, enc.encode(cBody));

    const cHash = await deps.hash.sha256(enc.encode(cBody));
    parche.rejectBlobAsSecret(cHash, ['assignment']);

    const summary = await syncOnce(deps, makeSyncOpts(token));

    expect(summary.pushed).toBe(2);
    expect(summary.errors).toEqual([]);
    expect(summary.blockedBySecretServer).toEqual([{ path: 'c.md', kinds: ['assignment'] }]);

    const state = await readState(deps.fs, VAULT);
    expect(state?.files['a.md']).toBeDefined();
    expect(state?.files['b.md']).toBeDefined();
    expect(state?.files['c.md']).toBeUndefined();
    expect(state?.blockedSecretServer?.['c.md']).toEqual({
      kinds: ['assignment'],
      hash: cHash,
      allowDigest: '', // c.md has no LOCAL finding — version-skew scenario, nothing exempted
      detectedAt: '2026-10-29T12:00:00.000Z',
    });

    // CHAMBA-023 §4: no secret value anywhere — summary, state, or the raw PUT body
    // is NOT inspected here (the server never stores a rejected blob), but the
    // SUMMARY and the STATE FILE (the two consumer-facing artifacts) must never
    // contain the raw value.
    expect(JSON.stringify(summary)).not.toContain(secretValue);
    expect(JSON.stringify(state)).not.toContain(secretValue);
  });

  it('S7.7 — two paths with IDENTICAL rejected content → both reported, exactly 1 PUT for the shared hash', async () => {
    const { parche, token, deps } = setupS7();
    const enc = new TextEncoder();

    const body = '# duplicated rejected content\n';
    await deps.fs.writeBytes(`${VAULT}/a.md`, enc.encode(body));
    await deps.fs.writeBytes(`${VAULT}/b.md`, enc.encode(body));
    const sharedHash = await deps.hash.sha256(enc.encode(body));
    parche.rejectBlobAsSecret(sharedHash, ['assignment']);

    const summary = await syncOnce(deps, makeSyncOpts(token));
    expect(summary.pushed).toBe(0);
    expect(summary.blockedBySecretServer?.map((b) => b.path).sort()).toEqual(['a.md', 'b.md']);
    expect(summary.errors).toEqual([]);

    const putCalls = parche.requestLog.filter(
      (r) => r.method === 'PUT' && r.url.endsWith(`/blob/${sharedHash}`),
    );
    expect(putCalls).toHaveLength(1);
  });

  // Review item 15: a file with a REAL local finding, fully exempted locally
  // (so the header is NOT empty) — the server rejects it anyway (version
  // skew: it has a rule the client doesn't, or is simply pickier). The
  // recorded `blockedSecretServer` entry must carry the REAL allowDigest
  // (the fingerprint that was actually sent), not an empty one.
  it('item 15 — all LOCAL findings exempted, header sent, server STILL rejects → recorded with its real (non-empty) allowDigest', async () => {
    const { parche, token, deps } = setupS7();
    const enc = new TextEncoder();

    const body = `# D\n${TOK('E')}`; // a real `assignment`-shaped secret
    await deps.fs.writeBytes(`${VAULT}/d.md`, enc.encode(body));
    const dHash = await deps.hash.sha256(enc.encode(body));

    // First sync: discover and exempt the local finding (never reaches the
    // server yet — the LOCAL gate blocks it until it's exempted).
    const blocked1 = await syncOnce(deps, makeSyncOpts(token));
    const fp = blocked1.blockedBySecret?.find((f) => f.path === 'd.md')?.fingerprint;
    expect(fp).toBeDefined();
    await addSecretAllowEntry(deps.fs, makeClock(), VAULT, { path: 'd.md', fingerprint: fp ?? '' });

    // The server rejects it unconditionally regardless of the header — models
    // a server rule stricter than (or different from) the local one.
    parche.rejectBlobAsSecret(dHash, ['assignment']);

    const summary2 = await syncOnce(deps, makeSyncOpts(token));
    expect(summary2.pushed).toBe(0);
    expect(summary2.blockedBySecret ?? []).toEqual([]); // passed the LOCAL gate
    expect(summary2.blockedBySecretServer).toEqual([{ path: 'd.md', kinds: ['assignment'] }]);

    // The header DID carry the real fingerprint …
    expect(parche.blobAllowHeaders.get(dHash)).toEqual([fp]);
    // … and the state entry's allowDigest reflects exactly that (never empty,
    // never a value — just the fingerprint already visible in the allowlist).
    const state = await readState(deps.fs, VAULT);
    expect(state?.blockedSecretServer?.['d.md']).toEqual({
      kinds: ['assignment'],
      hash: dHash,
      allowDigest: fp,
      detectedAt: '2026-10-29T12:00:00.000Z',
    });
  });
});

describe('CHAMBA-023 S5 — blockedSecretServer hash+allowDigest lifecycle (D-Q1(b) + B3, real knobs)', () => {
  it('hash unchanged AND allowDigest unchanged → the 2nd sync skips WITHOUT a PUT', async () => {
    const { parche, token, deps } = setupS7();
    const enc = new TextEncoder();

    const body = '# version-skew note, no local finding at all\n';
    await deps.fs.writeBytes(`${VAULT}/c.md`, enc.encode(body));
    const cHash = await deps.hash.sha256(enc.encode(body));
    parche.rejectBlobAsSecret(cHash, ['jwt']);

    const summary1 = await syncOnce(deps, makeSyncOpts(token));
    expect(summary1.blockedBySecretServer).toEqual([{ path: 'c.md', kinds: ['jwt'] }]);
    const putsAfterFirst = parche.requestLog.filter(
      (r) => r.method === 'PUT' && r.url.endsWith(`/blob/${cHash}`),
    ).length;
    expect(putsAfterFirst).toBe(1);

    // 2nd sync: same content (same hash), nothing exempted either time (same
    // allowDigest, both ''). D-Q1(b)/B3: skipped entirely, no new PUT.
    const summary2 = await syncOnce(deps, makeSyncOpts(token));
    expect(summary2.blockedBySecretServer).toEqual([{ path: 'c.md', kinds: ['jwt'] }]);
    const putsAfterSecond = parche.requestLog.filter(
      (r) => r.method === 'PUT' && r.url.endsWith(`/blob/${cHash}`),
    ).length;
    expect(putsAfterSecond).toBe(1); // unchanged
  });

  it('content changes (new hash) → the stale entry clears and the file uploads', async () => {
    const { parche, token, deps } = setupS7();
    const enc = new TextEncoder();

    const body = '# rejected note\n';
    await deps.fs.writeBytes(`${VAULT}/c.md`, enc.encode(body));
    const cHash = await deps.hash.sha256(enc.encode(body));
    parche.rejectBlobAsSecret(cHash, ['jwt']);

    const summary1 = await syncOnce(deps, makeSyncOpts(token));
    expect(summary1.blockedBySecretServer).toEqual([{ path: 'c.md', kinds: ['jwt'] }]);

    await deps.fs.writeBytes(`${VAULT}/c.md`, enc.encode('# now clean\n'));
    const summary2 = await syncOnce(deps, makeSyncOpts(token));
    expect(summary2.pushed).toBe(1);
    expect(summary2.blockedBySecretServer ?? []).toEqual([]);

    const state = await readState(deps.fs, VAULT);
    expect(state?.blockedSecretServer ?? {}).toEqual({});
    expect(state?.files['c.md']).toBeDefined();
  });

  it('B3 — hash unchanged but the RECORDED allowDigest no longer matches (e.g. a newer chamba exempted a newly-detected finding) → retries, and if the server now accepts, uploads and clears the entry', async () => {
    const { parche, token, deps } = setupS7();
    const enc = new TextEncoder();

    // No local finding at all — the content the server rejected.
    const body = '# version-skew note, no local finding\n';
    await deps.fs.writeBytes(`${VAULT}/c.md`, enc.encode(body));
    const cHash = await deps.hash.sha256(enc.encode(body));

    // Seed a state as if a PREVIOUS (older) chamba version recorded this
    // rejection with some allowDigest that does NOT match what the CURRENT
    // scan produces for this content (today: ''). This is the one mechanism
    // that can't be reproduced by driving two real syncOnce calls back to
    // back under a single, fixed ruleset — a ruleset upgrade is exactly what
    // would change "what's found and exempted for unchanged content" in
    // production, and this seed stands in for that upgrade having happened.
    await writeState(deps.fs, VAULT, {
      server: SERVER,
      slug: SLUG,
      cursor: 0,
      files: {},
      blockedSecretServer: {
        'c.md': {
          kinds: ['jwt'],
          hash: cHash,
          allowDigest: 'deadbeefc0de', // deliberately does NOT match current (−− '')
          detectedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    });

    // No rejection knob set for `cHash` at all — the server simply accepts
    // this content now (modeling the server having been updated too, so it
    // no longer flags it).
    const summary = await syncOnce(deps, makeSyncOpts(token));
    expect(summary.pushed).toBe(1);
    expect(summary.blockedBySecretServer ?? []).toEqual([]);

    const putCalls = parche.requestLog.filter(
      (r) => r.method === 'PUT' && r.url.endsWith(`/blob/${cHash}`),
    );
    expect(putCalls).toHaveLength(1); // it WAS retried — allowDigest mismatch, not skipped

    const state = await readState(deps.fs, VAULT);
    expect(state?.blockedSecretServer ?? {}).toEqual({}); // cleared
    expect(state?.files['c.md']).toBeDefined();
  });
});

describe('CHAMBA-023 S7.9 — missing_blobs reported in parts (real knobs: rejectPushBlobsOnce + rejectBlobAsSecret)', () => {
  it('S7.9(a) — round 1 reports {h1} (rejected as secret), round 2 reports {h2} (never-before-reported, clean) → push does NOT abort', async () => {
    const { parche, token, deps } = setupS7();
    const enc = new TextEncoder();

    const bytes1 = enc.encode('# File 1\n');
    const bytes2 = enc.encode('# File 2\n');
    const h1 = await deps.hash.sha256(bytes1);
    await deps.fs.writeBytes(`${VAULT}/f1.md`, bytes1);
    await deps.fs.writeBytes(`${VAULT}/f2.md`, bytes2);

    // Round 1: the ONLY reported-missing hash is h1 (rejectPushBlobsOnce fires
    // before the natural missing-blob check) — PUT h1 → secret rejection.
    // Round 2: the batch (now only f2) is pushed again → h2 is naturally
    // missing (never uploaded before) → PUT h2 → accepted.
    parche.rejectPushBlobsOnce([h1]);
    parche.rejectBlobAsSecret(h1, ['jwt']);

    const summary = await syncOnce(deps, makeSyncOpts(token));
    expect(summary.errors).toEqual([]);
    expect(summary.pushed).toBe(1);
    expect(summary.blockedBySecretServer).toEqual([{ path: 'f1.md', kinds: ['jwt'] }]);

    const state = await readState(deps.fs, VAULT);
    expect(state?.files['f2.md']).toBeDefined();
    expect(state?.files['f1.md']).toBeUndefined();
  });

  it('S7.9(b) — a secret-rejected hash is handled in exactly 1 attempt, never retried, even while a sibling hash still aborts after 2', async () => {
    const { parche, token, deps } = setupS7();
    const enc = new TextEncoder();

    const bytesOk = enc.encode('# clean file, reported missing repeatedly\n');
    const bytesSecret = enc.encode('# secret-shaped file\n');
    const hOk = await deps.hash.sha256(bytesOk);
    const hSecret = await deps.hash.sha256(bytesSecret);
    await deps.fs.writeBytes(`${VAULT}/ok.md`, bytesOk);
    await deps.fs.writeBytes(`${VAULT}/secretish.md`, bytesSecret);
    parche.rejectBlobAsSecret(hSecret, ['assignment']);

    // Round 1 reports BOTH missing together (knob counts >0 for both): hOk
    // gets PUT (ok, attempt 1/2), hSecret gets rejected as a secret — and is
    // handled IMMEDIATELY (review item 5: secret-rejected hashes get exactly
    // 1 attempt, never retried; a successfully-PUT hash gets a 2nd attempt if
    // re-reported). hSecret is also removed from the batch right away, so no
    // later round can ever report it again (its own knob count — 1 — is
    // irrelevant after that point). hOk keeps being forcibly re-reported
    // (count 3) until it exhausts its 2-attempt budget and the containment
    // guard throws on the 3rd report.
    parche.rejectPushBlobsOnce([hOk, hOk, hOk, hSecret]);

    await expect(syncOnce(deps, makeSyncOpts(token))).rejects.toThrow(
      /no se pudo completar el push: faltan blobs/,
    );
    // Nothing was written to state on this failure.
    expect(await readState(deps.fs, VAULT)).toBeNull();

    const putsFor = (h: string) =>
      parche.requestLog.filter((r) => r.method === 'PUT' && r.url.endsWith(`/blob/${h}`)).length;
    expect(putsFor(hSecret)).toBe(1); // secret-rejected: exactly 1 attempt
    expect(putsFor(hOk)).toBe(2); // successfully-PUT: exactly 2 attempts before giving up
  });

  it('S7.9(c) — a successfully-PUT hash gets ONE retry if re-reported missing (review item 5), but a 2nd re-report still ABORTS', async () => {
    const { parche, token, deps } = setupS7();
    const enc = new TextEncoder();

    const bytesOk = enc.encode('# clean file, reported missing repeatedly\n');
    const hOk = await deps.hash.sha256(bytesOk);
    await deps.fs.writeBytes(`${VAULT}/ok.md`, bytesOk);

    // hOk is reported missing 3 times total (rounds 1, 2, 3), regardless of
    // whether it was actually just PUT — this models a flaky/eventually-
    // consistent server. Round 1: PUT (attempt 1/2). Round 2: still "missing"
    // → retried (attempt 2/2, review item 5's one extra try). Round 3: still
    // "missing" a 3rd time → now fully handled (2/2 attempts used) → the
    // containment guard throws instead of a 3rd PUT attempt.
    parche.rejectPushBlobsOnce([hOk, hOk, hOk]);

    await expect(syncOnce(deps, makeSyncOpts(token))).rejects.toThrow(
      /no se pudo completar el push: faltan blobs/,
    );
    expect(await readState(deps.fs, VAULT)).toBeNull();

    // Exactly 2 PUT attempts were made for hOk (not 1, not 3+).
    const putCalls = parche.requestLog.filter(
      (r) => r.method === 'PUT' && r.url.endsWith(`/blob/${hOk}`),
    );
    expect(putCalls).toHaveLength(2);
  });
});

describe('CHAMBA-023 S7.8 — B3: single-file batch rejected leaves an empty batch (real knobs)', () => {
  it('the ONLY file in the sync is rejected → no empty-batch crash, sync ends OK with pushed:0', async () => {
    const { parche, token, deps } = setupS7();
    const enc = new TextEncoder();
    const body = '# only file\n';
    await deps.fs.writeBytes(`${VAULT}/only.md`, enc.encode(body));
    const onlyHash = await deps.hash.sha256(enc.encode(body));
    parche.rejectBlobAsSecret(onlyHash, ['assignment']);

    const summary = await syncOnce(deps, makeSyncOpts(token));
    expect(summary.pushed).toBe(0);
    expect(summary.errors).toEqual([]);
    expect(summary.blockedBySecretServer).toEqual([{ path: 'only.md', kinds: ['assignment'] }]);
  });
});

describe('CHAMBA-023 S7.11 — regression, no PUT-error confusion (real knobs: failPutBlob)', () => {
  it('403 on PUT still aborts the sync (never mistaken for secret_detected)', async () => {
    const { token, deps, parche } = setupS7();
    const enc = new TextEncoder();
    await deps.fs.writeBytes(`${VAULT}/a.md`, enc.encode('# A\n'));
    const aHash = await deps.hash.sha256(enc.encode('# A\n'));
    parche.failPutBlob(aHash, 403);

    await expect(syncOnce(deps, makeSyncOpts(token))).rejects.toThrow();
  });

  it('500 on PUT still aborts the sync (never mistaken for secret_detected)', async () => {
    const { token, deps, parche } = setupS7();
    const enc = new TextEncoder();
    await deps.fs.writeBytes(`${VAULT}/a.md`, enc.encode('# A\n'));
    const aHash = await deps.hash.sha256(enc.encode('# A\n'));
    parche.failPutBlob(aHash, 500);

    await expect(syncOnce(deps, makeSyncOpts(token))).rejects.toThrow();
  });

  it('422 missing_blobs (unrelated to secret_detected) keeps working', async () => {
    const { token, deps, parche } = setupS7();
    const enc = new TextEncoder();
    const bytes = enc.encode('# note\n');
    const h = await deps.hash.sha256(bytes);
    await deps.fs.writeBytes(`${VAULT}/note.md`, bytes);
    parche.rejectPushBlobsOnce([h]);

    const summary = await syncOnce(deps, makeSyncOpts(token));
    expect(summary.pushed).toBe(1);
    expect(summary.errors).toEqual([]);
  });
});

describe('CHAMBA-023 S7.10 — phase 3 (conflict copy) rejected by the server', () => {
  it('a conflict copy whose blob the server rejects lands in blockedBySecretServer; the rest of the sync finishes OK', async () => {
    const { parche, group, deps } = setupS7();
    const u1 = parche.addDevice(group.id, { userId: 'u2', label: 'phone', role: 'editor' });
    const enc = new TextEncoder();

    const remoteBytes = enc.encode('# remote version\n');
    const remoteHash = await deps.hash.sha256(remoteBytes);
    parche.seedBlob(group.id, remoteHash, remoteBytes);
    parche.seedChange(group.id, {
      path: 'note.md',
      hash: remoteHash,
      author: 'other',
      device: 'their-device',
      at: '2026-10-29T10:00:00Z',
    });

    const localMarkdown = '# local conflicting version\n';
    await deps.fs.writeBytes(`${VAULT}/note.md`, enc.encode(localMarkdown));

    // Predict the exact conflict-copy bytes (CHAMBA-021 D3): frontmatter is
    // deterministic from {conflictOf, conflictBase} — `conflictBase` is `null`
    // because `note.md` was never synced before (no entry in state.files).
    const copyBytes = enc.encode(
      addConflictFrontmatter(localMarkdown, { conflictOf: 'note.md', conflictBase: null }),
    );
    const copyHash = await deps.hash.sha256(copyBytes);
    parche.rejectBlobAsSecret(copyHash, ['assignment']);

    const summary = await syncOnce(deps, makeSyncOpts(u1));

    expect(summary.conflicts).toEqual([{ path: 'note.md', copyPath: 'note (conflicto joys).md' }]);
    expect(summary.blockedBySecretServer).toEqual([
      { path: 'note (conflicto joys).md', kinds: ['assignment'] },
    ]);
    expect(summary.errors).toEqual([]);

    const state = await readState(deps.fs, VAULT);
    expect(state?.files['note (conflicto joys).md']).toBeUndefined();
  });

  it('variant: content already rejected in phase 1 is NOT re-PUT in phase 3 (rejectedHashes shared, 1 PUT total)', async () => {
    const { parche, group, deps } = setupS7();
    const u1 = parche.addDevice(group.id, { userId: 'u2', label: 'phone', role: 'editor' });
    const enc = new TextEncoder();

    const localMarkdown = '# decoy-shared conflicting version\n';
    // Pre-compute the exact bytes the phase-3 conflict copy of `note.md` will
    // have, and write THOSE SAME BYTES as an unrelated, ordinary phase-1 file
    // (`decoy.md`) — so both entries end up pushing the SAME hash. Rejecting
    // that hash in phase 1 must mean phase 3 never attempts the PUT again.
    const decoyBytes = enc.encode(
      addConflictFrontmatter(localMarkdown, { conflictOf: 'note.md', conflictBase: null }),
    );
    const sharedHash = await deps.hash.sha256(decoyBytes);
    parche.rejectBlobAsSecret(sharedHash, ['assignment']);

    await deps.fs.writeBytes(`${VAULT}/decoy.md`, decoyBytes);
    await deps.fs.writeBytes(`${VAULT}/note.md`, enc.encode(localMarkdown));

    const remoteBytes = enc.encode('# remote version 2\n');
    const remoteHash = await deps.hash.sha256(remoteBytes);
    parche.seedBlob(group.id, remoteHash, remoteBytes);
    parche.seedChange(group.id, {
      path: 'note.md',
      hash: remoteHash,
      author: 'other',
      device: 'their-device',
      at: '2026-10-29T10:00:00Z',
    });

    const summary = await syncOnce(deps, makeSyncOpts(u1));

    expect(summary.errors).toEqual([]);
    expect(summary.blockedBySecretServer?.map((b) => b.path).sort()).toEqual([
      'decoy.md',
      'note (conflicto joys).md',
    ]);

    const putCalls = parche.requestLog.filter(
      (r) => r.method === 'PUT' && r.url.endsWith(`/blob/${sharedHash}`),
    );
    expect(putCalls).toHaveLength(1);
  });
});

describe('CHAMBA-023 S7.12 — adoption via joinOnce (real knobs)', () => {
  it('a vault whose only file is server-rejected: join completes, blockedSecretServer recorded, pendingAdoption cleared', async () => {
    const parche = new FakeParche(makeClock());
    setupGroup(parche);
    const fs = new MemoryFilesystem();
    const deps = { fs, http: parche, hash: new FakeHash(), clock: makeClock() };
    const enc = new TextEncoder();

    const body = '# pre-existing note, server will reject it\n';
    await fs.writeBytes(`${VAULT}/secret.md`, enc.encode(body));
    const hash = await deps.hash.sha256(enc.encode(body));
    parche.rejectBlobAsSecret(hash, ['assignment']);

    const result = await joinOnce(deps, {
      vaultDir: VAULT,
      server: SERVER,
      homedir: '/home/test',
      joinRequest: { code: 'ABCD-1234', name: 'joys', email: 'joys@test.com' },
    });

    expect(result.summary.blockedBySecretServer).toEqual([
      { path: 'secret.md', kinds: ['assignment'] },
    ]);

    const state = await readState(fs, VAULT);
    expect(state?.blockedSecretServer?.['secret.md']).toEqual({
      kinds: ['assignment'],
      hash,
      allowDigest: '',
      detectedAt: '2026-10-29T12:00:00.000Z',
    });
    expect(state?.pendingAdoption).not.toBe(true);
  });
});

describe('CHAMBA-023 S7.13 — the exact seed fixture (auth/magic-link.md) pushes clean, end-to-end', () => {
  it('the seed content is negative: pushed 1, blockedBySecret empty, blockedSecretServer absent', async () => {
    const { token, deps } = setupS7();
    const enc = new TextEncoder();

    // Literal content of `auth/magic-link.md` from parche/scripts/seed-cya.ts
    // (~L253-271) — the empirical false-positive the CHAMBA-023 plan §0 fixes.
    const seedContent = `---
title: Magic Links
tags: [tema/auth]
work_item: AUTH-40
---

# Magic Links

Un magic link es un URL con un token de un solo uso para autenticación sin contraseña.

## Generación

\`\`\`
token = crypto.randomUUID()
tokenHash = sha256(token)
link = publicUrl + "/auth#" + token
\`\`\`

## Validación

El servidor valida que:
- El token exista en \`magic_links\`.
- No haya expirado (\`expires_at > now\`).
- No se haya usado ya (\`used_at IS NULL\`).

Ver [[auth/flujo-login]] para el flujo completo.
`;
    await deps.fs.writeBytes(`${VAULT}/auth/magic-link.md`, enc.encode(seedContent));

    const summary = await syncOnce(deps, makeSyncOpts(token));
    expect(summary.pushed).toBe(1);
    expect(summary.blockedBySecret ?? []).toEqual([]);
    expect(summary.blockedBySecretServer ?? []).toEqual([]);

    const state = await readState(deps.fs, VAULT);
    expect(state?.blockedSecret ?? {}).toEqual({});
    expect(state?.blockedSecretServer ?? {}).toEqual({});
  });
});

// ─── CHAMBA-023 D-Q3 — content-based scanning for non-.md syncable files ─────

describe('CHAMBA-023 D-Q3 — PNG (not scanned) and PDF (scanned by content) over syncOnce', () => {
  it('a real PNG (0x89 PNG signature, invalid UTF-8) uploads WITHOUT being scanned, even with secret-shaped ASCII inside', async () => {
    const { parche, token, deps } = setupS7();

    const pngBytes = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature — 0x89 alone is already invalid UTF-8
      ...new TextEncoder().encode(`token: pch_${'Z'.repeat(24)}`),
      0xff,
      0xfe, // trailing bytes that are also never valid UTF-8 lead bytes
    ]);
    await deps.fs.writeBytes(`${VAULT}/image.png`, pngBytes);

    const summary = await syncOnce(deps, makeSyncOpts(token));
    expect(summary.pushed).toBe(1);
    expect(summary.blockedBySecret ?? []).toEqual([]);

    const hash = await deps.hash.sha256(pngBytes);
    // Never scanned → no fingerprints to send, ever.
    expect(parche.blobAllowHeaders.get(hash)).toEqual([]);
  });

  it('a text .pdf with a secret-shaped token is blocked locally; once exempted via the allowlist it uploads with the fingerprint in the header, accepted by requireBlobAllowFingerprints', async () => {
    const { parche, token, deps } = setupS7();
    const enc = new TextEncoder();

    const pdfText = `%PDF-ish text content\n${TOK('D')}`;
    const pdfBytes = enc.encode(pdfText);
    await deps.fs.writeBytes(`${VAULT}/doc.pdf`, pdfBytes);
    const pdfHash = await deps.hash.sha256(pdfBytes);

    const summary1 = await syncOnce(deps, makeSyncOpts(token));
    expect(summary1.pushed).toBe(0);
    const fp = summary1.blockedBySecret?.find((f) => f.path === 'doc.pdf')?.fingerprint;
    expect(fp).toBeDefined();

    await addSecretAllowEntry(deps.fs, makeClock(), VAULT, {
      path: 'doc.pdf',
      fingerprint: fp ?? '',
    });

    // Model the server's side of the contract: it only accepts this hash when
    // the fingerprint it would independently find is exempted via the header.
    parche.requireBlobAllowFingerprints(pdfHash, {
      kinds: ['assignment'],
      fingerprints: [fp ?? ''],
    });

    const summary2 = await syncOnce(deps, makeSyncOpts(token));
    expect(summary2.pushed).toBe(1);
    expect(summary2.blockedBySecret ?? []).toEqual([]);
    expect(summary2.blockedBySecretServer ?? []).toEqual([]);
    expect(parche.blobAllowHeaders.get(pdfHash)).toEqual([fp]);
  });
});
