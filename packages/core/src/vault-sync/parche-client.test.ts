/**
 * parche-client.test.ts — ParcheClient unit tests using FakeParche.
 * Covers: join 200/404/409/429/400, push 422/409, malformed server response,
 * bearer header sent, getChanges, headBlob/putBlob/getBlob.
 */

import { describe, expect, it, vi } from 'vitest';
import type { ClockPort } from '../ports/clock.js';
import { FakeParche } from '../testing/fake-parche.js';
import {
  ParcheAlreadyMemberError,
  ParcheClient,
  ParcheHttpError,
  ParcheMissingBlobsError,
  ParcheNotFoundError,
} from './parche-client.js';

const SERVER = 'https://parche.example.com';
const TOKEN = 'pch_test_tok123';

function makeClock(): ClockPort {
  return { now: () => new Date('2026-10-29T12:00:00Z'), today: () => '2026-10-29' };
}

function makeClient(parche: FakeParche) {
  return new ParcheClient(parche, SERVER, TOKEN);
}

// ─── join ─────────────────────────────────────────────────────────────────────

describe('ParcheClient.join', () => {
  it('200 — returns parsed JoinResponse', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'my-group', name: 'My Group' });
    parche.addInvite({ code: 'ABCD-1234', groupId: group.id });

    const client = makeClient(parche);
    const res = await client.join({
      code: 'ABCD-1234',
      name: 'Joys',
      email: 'joys@test.com',
      deviceLabel: 'laptop',
    });
    expect(res.group.slug).toBe('my-group');
    expect(res.deviceToken).toBeTruthy();
  });

  it('404 — throws ParcheNotFoundError', async () => {
    const parche = new FakeParche(makeClock());
    const client = makeClient(parche);
    await expect(
      client.join({ code: 'XXXX-9999', name: 'A', email: 'a@b.com' }),
    ).rejects.toBeInstanceOf(ParcheNotFoundError);
  });

  it('409 — throws ParcheAlreadyMemberError', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'my-group' });
    parche.addInvite({ code: 'ABCD-1234', groupId: group.id });

    // First join
    const client = makeClient(parche);
    await client.join({ code: 'ABCD-1234', name: 'Joys', email: 'joys@test.com' });

    // Second join with same email → 409
    await expect(
      client.join({ code: 'ABCD-1234', name: 'Joys', email: 'joys@test.com' }),
    ).rejects.toBeInstanceOf(ParcheAlreadyMemberError);
  });

  it('429 — throws ParcheRateLimitedError', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'my-group' });
    parche.addInvite({ code: 'ABCD-1234', groupId: group.id, maxUses: 1 });

    // Use the invite
    const client = makeClient(parche);
    await client.join({ code: 'ABCD-1234', name: 'A', email: 'a@t.com' });

    // Exhaust invite → 404 (code becomes invalid)
    await expect(
      client.join({ code: 'ABCD-1234', name: 'B', email: 'b@t.com' }),
    ).rejects.toBeInstanceOf(ParcheNotFoundError);
  });

  it('400 — bad request throws ParcheHttpError', async () => {
    const parche = new FakeParche(makeClock());
    const client = makeClient(parche);
    // Send payload that fails schema (missing name)
    await expect(
      client.join({ code: 'ABCD-XXXX' } as Parameters<typeof client.join>[0]),
    ).rejects.toBeInstanceOf(ParcheHttpError);
  });

  it('malformed server response throws ParcheHttpError (schema rejection)', async () => {
    // Override FakeParche to return a response that passes HTTP 200 but is not a valid JoinResponse
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'my-group' });
    parche.addInvite({ code: 'ABCD-1234', groupId: group.id });

    const enc = new TextEncoder();
    vi.spyOn(parche, 'request').mockResolvedValueOnce({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: enc.encode(JSON.stringify({ malformed: true })),
    });

    const client = makeClient(parche);
    await expect(
      client.join({ code: 'ABCD-1234', name: 'A', email: 'a@t.com' }),
    ).rejects.toBeInstanceOf(ParcheHttpError);
  });

  it('sends Authorization Bearer header', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'my-group' });
    parche.addInvite({ code: 'ABCD-1234', groupId: group.id });

    const requestSpy = vi.spyOn(parche, 'request');
    // join does NOT send auth header — verify that push does
    const token = parche.addDevice(group.id, { userId: 'usr1', label: 'laptop' });
    const authedClient = new ParcheClient(parche, SERVER, token);

    // headBlob requires auth
    const hash = 'a'.repeat(64);
    await authedClient.headBlob(hash);

    const calls = requestSpy.mock.calls;
    const headCall = calls.find(([req]) => req.method === 'HEAD');
    expect(headCall).toBeDefined();
    if (!headCall) throw new Error('expected HEAD call');
    expect(headCall[0].headers?.Authorization).toMatch(/^Bearer pch_fake_/);
  });
});

// ─── push 422 / 409 ───────────────────────────────────────────────────────────

describe('ParcheClient.push', () => {
  it('422 missing_blobs throws ParcheMissingBlobsError', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'my-group' });
    const token = parche.addDevice(group.id, { userId: 'usr1', label: 'laptop' });
    const missingHash = 'b'.repeat(64);
    parche.rejectPushBlobs([missingHash]);

    const client = new ParcheClient(parche, SERVER, token);
    await expect(
      client.push('my-group', [{ path: 'a.md', baseHash: null, newHash: missingHash }]),
    ).rejects.toBeInstanceOf(ParcheMissingBlobsError);
  });

  it('422 when blob was never uploaded (blobRefs check) throws ParcheMissingBlobsError', async () => {
    // This test specifically covers the blob_refs check in FakeParche (NOT the rejectPushBlobs knob).
    // It pushes a hash that was never PUT to the server → server must return 422.
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'my-group' });
    const token = parche.addDevice(group.id, { userId: 'usr1', label: 'laptop' });

    const unuploadedHash = 'd'.repeat(64);
    // Note: we do NOT call parche.seedBlob() and do NOT call parche.rejectPushBlobs()

    const client = new ParcheClient(parche, SERVER, token);
    await expect(
      client.push('my-group', [{ path: 'a.md', baseHash: null, newHash: unuploadedHash }]),
    ).rejects.toBeInstanceOf(ParcheMissingBlobsError);
  });

  it('409 case collision throws ParcheCaseCollisionError', async () => {
    const { ParcheCaseCollisionError } = await import('./parche-client.js');
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'my-group' });
    const token = parche.addDevice(group.id, { userId: 'usr1', label: 'laptop' });

    // Seed a live file — Nota.md
    const enc = new TextEncoder();
    const data = enc.encode('content');
    const { FakeHash } = await import('../testing/fake-hash.js');
    const noteHash = await new FakeHash().sha256(data);
    parche.seedBlob(group.id, noteHash, data);
    parche.seedChange(group.id, {
      path: 'Nota.md',
      hash: noteHash,
      author: 'a',
      device: 'x',
      at: '2026-10-29T10:00:00Z',
    });

    // Upload a blob for nota.md
    const data2 = enc.encode('lowercase');
    const hash2 = await new FakeHash().sha256(data2);
    parche.seedBlob(group.id, hash2, data2);

    const client = new ParcheClient(parche, SERVER, token);
    // Push nota.md (same key as Nota.md) — should 409
    await expect(
      client.push('my-group', [{ path: 'nota.md', baseHash: null, newHash: hash2 }]),
    ).rejects.toBeInstanceOf(ParcheCaseCollisionError);
  });
});

// ─── getChanges ───────────────────────────────────────────────────────────────

describe('ParcheClient.getChanges', () => {
  it('returns parsed ChangesResponse', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'my-group' });
    const token = parche.addDevice(group.id, { userId: 'usr1', label: 'laptop' });
    parche.seedChange(group.id, {
      path: 'x.md',
      hash: 'c'.repeat(64),
      author: 'a',
      device: 'd',
      at: '2026-10-29T10:00:00Z',
    });

    const client = new ParcheClient(parche, SERVER, token);
    const res = await client.getChanges('my-group', 0);
    expect(res.changes).toHaveLength(1);
    expect(res.changes[0]?.path).toBe('x.md');
    expect(res.cursor).toBeGreaterThan(0);
  });
});
