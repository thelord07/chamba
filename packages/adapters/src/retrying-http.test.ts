/**
 * retrying-http.test.ts — Tests 4–9 for RetryingHttp (CHAMBA-014 B3).
 *
 * All tests are pure: no real network calls, no HOME directory.
 * Uses FakeParche + FlakyHttp (from @chamba/core/testing) and MemoryFilesystem.
 */

import type { ClockPort, HttpResponse } from '@chamba/core';
import {
  FakeHash,
  FakeParche,
  FlakyHttp,
  MemoryFilesystem,
  ParcheNetworkError,
  syncOnce,
} from '@chamba/core';
import { describe, expect, it, vi } from 'vitest';
import { RetryingHttp } from './retrying-http.js';

// ─── Shared helpers ───────────────────────────────────────────────────────────

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

function setupGroup(parche: FakeParche) {
  const group = parche.seedGroup({ slug: SLUG, name: 'Test Group' });
  parche.addInvite({ code: 'ABCD-1234', groupId: group.id, role: 'editor' });
  return group;
}

function makeToken(parche: FakeParche, group: ReturnType<FakeParche['seedGroup']>) {
  return parche.addDevice(group.id, { userId: 'usr1', label: 'laptop', role: 'editor' });
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

/** No-op sleep for speed (never waits). */
const noopSleep = () => Promise.resolve();

// ─── Test 4 — Push idempotent with ECONNRESET (post-send) ────────────────────

describe('Test 4 — push idempotent: ECONNRESET post-send retries and ok', () => {
  it('ECONNRESET after push applied: reintento → ok con mismo seq', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const fs = new MemoryFilesystem();
    const hash = new FakeHash();

    await fs.writeBytes(`${VAULT}/note.md`, new TextEncoder().encode('# Note'));

    // Inject 1 post-send ECONNRESET on the push route.
    const flaky = new FlakyHttp(parche, {
      seed: 1,
      rate: 0,
      code: 'ECONNRESET',
      mode: 'post',
      match: (req) => req.url.includes('/push'),
    });
    flaky.failNext(1, 'ECONNRESET', 'post');

    const retrying = new RetryingHttp(flaky, { sleep: noopSleep });

    const summary = await syncOnce(
      { fs, http: retrying, hash, clock: makeClock() },
      makeSyncOpts(token),
    );

    expect(summary.pushed).toBe(1);
    expect(summary.conflicts).toHaveLength(0);

    // Server state should be the same as a clean push.
    const livePaths = parche.livePaths(group.id);
    expect(livePaths.has('note.md')).toBe(true);
    expect(parche.blobHashes(group.id)).toHaveLength(1);
  });

  it('variante: otro cliente avanza entre el push aplicado y el reintento → conflict copy', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const fs = new MemoryFilesystem();
    const hash = new FakeHash();

    await fs.writeBytes(`${VAULT}/shared.md`, new TextEncoder().encode('local content'));

    // After push is applied and before retry: another client advances the file.
    let firstPush = true;
    const interceptor = {
      async request(req: Parameters<typeof parche.request>[0]) {
        const res = await parche.request(req);
        if (req.url.includes('/push') && firstPush) {
          firstPush = false;
          // Another device pushes a new version of the same file.
          const otherBytes = new TextEncoder().encode('other content');
          const otherHash = await hash.sha256(otherBytes);
          parche.seedBlob(group.id, otherHash, otherBytes);
          parche.seedChange(group.id, {
            path: 'shared.md',
            hash: otherHash,
            author: 'other',
            device: 'other',
            at: '2026-10-29T12:01:00Z',
          });
          // Simulate ECONNRESET: throw after the push was applied.
          const err = new Error('ECONNRESET') as Error & { code?: string };
          err.code = 'ECONNRESET';
          throw err;
        }
        return res;
      },
    };

    const retrying = new RetryingHttp(interceptor, { sleep: noopSleep });
    const summary = await syncOnce(
      { fs, http: retrying, hash, clock: makeClock() },
      makeSyncOpts(token),
    );

    // Should have a conflict (the retry sees conflict because other client advanced).
    expect(summary.conflicts).toHaveLength(1);
    expect(summary.conflicts[0]?.path).toBe('shared.md');
  });
});

// ─── Test 5 — Join retry policy ───────────────────────────────────────────────

describe('Test 5 — join retry policy', () => {
  it('ECONNREFUSED (pre-send) → reintenta y completa', async () => {
    const parche = new FakeParche(makeClock());
    // Valid invite code (regex: ^[A-Z0-9]{4}-[A-Z0-9]{4}$)
    const group = parche.seedGroup({ slug: 'grp' });
    parche.addInvite({ code: 'GRPX-0001', groupId: group.id });

    let attempts = 0;
    const interceptor = {
      async request(req: Parameters<typeof parche.request>[0]) {
        if (req.url.includes('/api/join')) {
          attempts++;
          if (attempts === 1) {
            const err = new Error('ECONNREFUSED') as Error & { code?: string };
            err.code = 'ECONNREFUSED';
            throw err;
          }
        }
        return parche.request(req);
      },
    };

    const retrying = new RetryingHttp(interceptor, { sleep: noopSleep });
    const res = await retrying.request({
      method: 'POST',
      url: `${SERVER}/api/join`,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(
        JSON.stringify({
          code: 'GRPX-0001',
          name: 'Joys',
          email: 'joys@test.com',
          deviceLabel: 'laptop',
        }),
      ),
    });

    expect(res.status).toBe(200);
    expect(attempts).toBe(2);
  });

  it('ECONNRESET (post-send) → 1 sola llamada, ParcheNetworkError con code ECONNRESET', async () => {
    let calls = 0;
    const interceptor = {
      async request() {
        calls++;
        const err = new Error('ECONNRESET') as Error & { code?: string };
        err.code = 'ECONNRESET';
        throw err;
      },
    };

    const retrying = new RetryingHttp(interceptor, { sleep: noopSleep });

    await expect(
      retrying.request({
        method: 'POST',
        url: `${SERVER}/api/join`,
        body: new TextEncoder().encode('{}'),
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ParcheNetworkError && err.code === 'ECONNRESET' && err.attempts === 1,
    );

    // Only 1 call: post-send ECONNRESET must not be retried for join.
    expect(calls).toBe(1);
  });
});

// ─── Test 6 — FlakyHttp rate 0.1, 20 seeds, 100 files ───────────────────────

/** Seeds whose first sync exhausts the 4 attempts on some request (deterministic PRNG). */
const SEEDS_NEEDING_RERUN = new Set([13]);

describe('Test 6 — rate 0.1, 20 seeds, 100 archivos → pending 0', () => {
  // Run with 20 different PRNG seeds to guard against lucky seeds.
  it.each(Array.from({ length: 20 }, (_, i) => i))('seed %i', async (seed) => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const fs = new MemoryFilesystem();
    const hash = new FakeHash();

    // Write 100 local files.
    for (let i = 0; i < 100; i++) {
      await fs.writeBytes(`${VAULT}/file${i}.md`, new TextEncoder().encode(`# File ${i}`));
    }

    const flaky = new FlakyHttp(parche, {
      seed,
      rate: 0.1,
      code: 'UND_ERR_CONNECT_TIMEOUT',
      mode: 'pre',
    });
    // Production policy (4 attempts). With independent 10 % failures a request exhausts its
    // retries with p = 0.1^4, so ~1 % of 100-file syncs still fail (seed 13 does). That run
    // must leave nothing corrupted and a plain re-run — what the error message tells the
    // user to do — must finish the job.
    const retrying = new RetryingHttp(flaky, { sleep: noopSleep });
    const deps = { fs, http: retrying, hash, clock: makeClock() };

    let runs = 0;
    for (;;) {
      runs++;
      try {
        await syncOnce(deps, makeSyncOpts(token));
        break;
      } catch (err) {
        expect(err).toBeInstanceOf(ParcheNetworkError);
        expect(runs).toBe(1); // at most one re-run
      }
    }
    expect(runs).toBe(SEEDS_NEEDING_RERUN.has(seed) ? 2 : 1);

    // All blobs and paths must be on the server.
    expect(parche.blobHashes(group.id)).toHaveLength(100);
    expect(parche.livePaths(group.id).size).toBe(100);

    // A second sync must push nothing (pending = 0).
    const summary2 = await syncOnce(deps, makeSyncOpts(token));
    expect(summary2.pushed).toBe(0);
  });
});

// ─── Test 7 — rate 1.0 → ParcheNetworkError; then clean sync completes ───────

describe('Test 7 — rate 1.0 → ParcheNetworkError; archivos locales intactos; sync sano completa', () => {
  it('rate 1.0 falla con ParcheNetworkError attempts=4; retry con red sana completa', async () => {
    const parche = new FakeParche(makeClock());
    const group = setupGroup(parche);
    const token = makeToken(parche, group);
    const fs = new MemoryFilesystem();
    const hash = new FakeHash();

    const originalBytes = new TextEncoder().encode('# Hello');
    await fs.writeBytes(`${VAULT}/hello.md`, originalBytes);

    const flaky = new FlakyHttp(parche, {
      seed: 0,
      rate: 1.0,
      code: 'ECONNRESET',
      mode: 'pre',
    });
    const retrying = new RetryingHttp(flaky, { sleep: noopSleep });

    // Should reject with ParcheNetworkError.
    const err = await syncOnce(
      { fs, http: retrying, hash, clock: makeClock() },
      makeSyncOpts(token),
    ).catch((e) => e);

    expect(err).toBeInstanceOf(ParcheNetworkError);
    const netErr = err as ParcheNetworkError;
    expect(netErr.attempts).toBe(4);
    expect(netErr.code).toBeTruthy();

    // Local file must be untouched.
    const localBytes = await fs.readBytes(`${VAULT}/hello.md`);
    expect(localBytes).toEqual(originalBytes);

    // No state.json should have been written (sync never completed).
    const { readState } = await import('@chamba/core');
    const state = await readState(fs, VAULT);
    expect(state).toBeNull();

    // Now sync with clean network → completes.
    const retrying2 = new RetryingHttp(parche, { sleep: noopSleep });
    const summary = await syncOnce(
      { fs, http: retrying2, hash, clock: makeClock() },
      makeSyncOpts(token),
    );
    expect(summary.pushed).toBe(1);
    expect(parche.livePaths(group.id).has('hello.md')).toBe(true);
  });
});

// ─── Test 8 — Abort during backoff ───────────────────────────────────────────

describe('Test 8 — abort during backoff → AbortError, no timers', () => {
  const failing = () => {
    let calls = 0;
    return {
      get calls() {
        return calls;
      },
      async request(): Promise<never> {
        calls++;
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      },
    };
  };
  const req = (signal: AbortSignal) => ({
    method: 'GET',
    url: `${SERVER}/api/g/${SLUG}/changes?since=0`,
    signal,
  });

  it('default sleep: abort during the wait rejects at once and leaves no timers', async () => {
    vi.useFakeTimers();
    try {
      const inner = failing();
      // random → 1: first wait is the full 300 ms
      const retrying = new RetryingHttp(inner, { random: () => 1 });
      const controller = new AbortController();
      const p = retrying.request(req(controller.signal));
      const settled = p.catch((e: unknown) => e);

      await vi.advanceTimersByTimeAsync(0); // first attempt fails, backoff timer armed
      expect(inner.calls).toBe(1);
      expect(vi.getTimerCount()).toBe(1);

      controller.abort();
      const err = (await settled) as Error;
      expect(err.name).toBe('AbortError');
      expect(err).not.toBeInstanceOf(ParcheNetworkError);
      expect(vi.getTimerCount()).toBe(0);
      expect(inner.calls).toBe(1); // no further attempt after the abort
    } finally {
      vi.useRealTimers();
    }
  });

  it('real clock: abort during a 3 s backoff settles in < 50 ms', async () => {
    const retrying = new RetryingHttp(failing(), { random: () => 1, baseMs: 3_000 });
    const controller = new AbortController();
    const p = retrying.request(req(controller.signal)).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 20)); // let the backoff start
    const t0 = performance.now();
    controller.abort();
    const err = (await p) as Error;
    expect(performance.now() - t0).toBeLessThan(50);
    expect(err.name).toBe('AbortError');
  });
});

// ─── Test 9 — 429 with Retry-After ───────────────────────────────────────────

describe('Test 9 — 429 Retry-After', () => {
  it('Retry-After: 2 → espera ~2000 ms y reintenta', async () => {
    vi.useFakeTimers();

    let call = 0;
    const interceptor = {
      async request(): Promise<HttpResponse> {
        call++;
        if (call === 1) {
          return {
            status: 429,
            headers: { 'retry-after': '2' },
            body: new Uint8Array(0),
          };
        }
        return { status: 200, headers: {}, body: new Uint8Array(0) };
      },
    };

    const sleepCalls: number[] = [];
    const fakeSleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms);
      // advance fake timers so the sleep resolves
      await vi.advanceTimersByTimeAsync(ms);
    };

    const retrying = new RetryingHttp(interceptor, { sleep: fakeSleep });

    const res = await retrying.request({ method: 'GET', url: `${SERVER}/api/health` });

    expect(res.status).toBe(200);
    expect(call).toBe(2);
    // Retry-After: 2 → sleep called with 2000ms
    expect(sleepCalls[0]).toBe(2000);

    vi.useRealTimers();
  });

  it('Retry-After: 120 → espera 10 000 ms (tope retryAfterCapMs)', async () => {
    vi.useFakeTimers();

    let call = 0;
    const interceptor = {
      async request(): Promise<HttpResponse> {
        call++;
        if (call === 1) {
          return {
            status: 429,
            headers: { 'retry-after': '120' },
            body: new Uint8Array(0),
          };
        }
        return { status: 200, headers: {}, body: new Uint8Array(0) };
      },
    };

    const sleepCalls: number[] = [];
    const fakeSleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms);
      await vi.advanceTimersByTimeAsync(ms);
    };

    const retrying = new RetryingHttp(interceptor, { sleep: fakeSleep, retryAfterCapMs: 10_000 });

    const res = await retrying.request({ method: 'GET', url: `${SERVER}/api/health` });

    expect(res.status).toBe(200);
    expect(sleepCalls[0]).toBe(10_000);

    vi.useRealTimers();
  });

  it('Retry-After como fecha HTTP → espera calculada correctamente', async () => {
    vi.useFakeTimers();

    // Set the future date 5 seconds from now.
    const futureDate = new Date(Date.now() + 5_000).toUTCString();

    let call = 0;
    const interceptor = {
      async request(): Promise<HttpResponse> {
        call++;
        if (call === 1) {
          return {
            status: 429,
            headers: { 'retry-after': futureDate },
            body: new Uint8Array(0),
          };
        }
        return { status: 200, headers: {}, body: new Uint8Array(0) };
      },
    };

    const sleepCalls: number[] = [];
    const fakeSleep = async (ms: number): Promise<void> => {
      sleepCalls.push(ms);
      await vi.advanceTimersByTimeAsync(ms);
    };

    const retrying = new RetryingHttp(interceptor, { sleep: fakeSleep });

    const res = await retrying.request({ method: 'GET', url: `${SERVER}/api/health` });

    expect(res.status).toBe(200);
    // Should wait approximately 5 s (≤ 10 s cap).
    expect(sleepCalls[0]).toBeGreaterThan(0);
    expect(sleepCalls[0]).toBeLessThanOrEqual(10_000);

    vi.useRealTimers();
  });
});

// ─── Unitarios adicionales ────────────────────────────────────────────────────

describe('Unit: never retry 4xx (except 429)', () => {
  it.each([
    400, 401, 403, 404, 422,
  ])('status %i → returned immediately, no retry', async (status) => {
    let calls = 0;
    const interceptor = {
      async request() {
        calls++;
        return { status, headers: {}, body: new Uint8Array(0) };
      },
    };

    const retrying = new RetryingHttp(interceptor, { sleep: noopSleep });
    const res = await retrying.request({ method: 'GET', url: `${SERVER}/api/resource` });

    expect(res.status).toBe(status);
    expect(calls).toBe(1);
  });
});

describe('Unit: 502/503/504 are retried', () => {
  it.each([502, 503, 504])('status %i → retried until 200', async (status) => {
    let calls = 0;
    const interceptor = {
      async request() {
        calls++;
        if (calls < 3) return { status, headers: {}, body: new Uint8Array(0) };
        return { status: 200, headers: {}, body: new Uint8Array(0) };
      },
    };

    const retrying = new RetryingHttp(interceptor, { sleep: noopSleep, maxAttempts: 4 });
    const res = await retrying.request({ method: 'GET', url: `${SERVER}/api/resource` });

    expect(res.status).toBe(200);
    expect(calls).toBe(3);
  });
});

describe('Unit: Uint8Array body reenvíado intacto en cada intento', () => {
  it('PUT /api/blob/... reenvía el mismo Uint8Array sin mutar', async () => {
    const body = new Uint8Array([1, 2, 3, 4, 5]);
    const receivedBodies: Uint8Array[] = [];
    let calls = 0;

    const interceptor = {
      async request(req: { body?: Uint8Array | string }) {
        calls++;
        if (req.body instanceof Uint8Array) {
          receivedBodies.push(new Uint8Array(req.body)); // snapshot
        }
        if (calls < 2) {
          const err = new Error('ECONNRESET') as Error & { code?: string };
          err.code = 'ECONNRESET';
          throw err;
        }
        return { status: 200, headers: {}, body: new Uint8Array(0) };
      },
    };

    const retrying = new RetryingHttp(interceptor, { sleep: noopSleep });
    await retrying.request({
      method: 'PUT',
      url: `${SERVER}/api/blob/${'a'.repeat(64)}`,
      body,
    });

    expect(calls).toBe(2);
    expect(receivedBodies).toHaveLength(2);
    // Both should be identical to the original.
    for (const received of receivedBodies) {
      expect(received).toEqual(body);
    }
  });
});

describe('Unit: log debug no contiene token/authorization/query ni cause', () => {
  it('debug log only contains method, path, attempt, code, waitMs', async () => {
    const logEntries: object[] = [];
    const logger = {
      debug(obj: object) {
        logEntries.push(obj);
      },
    };

    let calls = 0;
    const interceptor = {
      async request() {
        calls++;
        if (calls < 2) {
          const err = new Error('ECONNRESET') as Error & { code?: string };
          err.code = 'ECONNRESET';
          throw err;
        }
        return { status: 200, headers: {}, body: new Uint8Array(0) };
      },
    };

    const retrying = new RetryingHttp(interceptor, { sleep: noopSleep, logger });
    await retrying.request({
      method: 'GET',
      url: `${SERVER}/api/g/${SLUG}/changes?since=0&token=pch_TESTSECRET123`,
      headers: { Authorization: 'Bearer pch_TESTSECRET123' },
    });

    expect(logEntries).toHaveLength(1);
    const entry = JSON.stringify(logEntries[0]);
    // Path should be without query string.
    expect(entry).not.toContain('pch_TESTSECRET');
    expect(entry).not.toContain('Authorization');
    expect(entry).not.toContain('cause');
    expect(entry).not.toContain('?since');
    // Should contain expected fields.
    expect(entry).toContain('method');
    expect(entry).toContain('attempt');
    expect(entry).toContain('code');
    expect(entry).toContain('waitMs');
  });
});

describe('Unit: ParcheNetworkError message no contiene token', () => {
  it('token falso pch_TESTSECRET123 en URL no aparece en ParcheNetworkError.message', async () => {
    const interceptor = {
      async request() {
        const err = new Error(
          'Connection refused to pch_TESTSECRET123@server?token=pch_TESTSECRET999',
        ) as Error & { code?: string };
        err.code = 'ECONNRESET';
        throw err;
      },
    };

    const retrying = new RetryingHttp(interceptor, { sleep: noopSleep, maxAttempts: 1 });

    const err = await retrying
      .request({
        method: 'GET',
        url: `${SERVER}/api/resource?token=pch_TESTSECRET123`,
      })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ParcheNetworkError);
    const netErr = err as ParcheNetworkError;
    expect(netErr.message).not.toContain('pch_TESTSECRET');
    expect(netErr.shortMessage).not.toContain('pch_TESTSECRET');
  });
});
