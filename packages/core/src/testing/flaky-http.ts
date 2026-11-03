/**
 * testing/flaky-http.ts — HttpPort decorator that injects network failures.
 * Pure: no node: imports.
 *
 * Used by tests to simulate transient and persistent network errors
 * in a deterministic, reproducible way (PRNG seeded with a fixed value).
 *
 * Two failure modes:
 *   'pre'  — throws BEFORE delegating to the wrapped HttpPort (simulates a
 *             connection that never reached the server, safe to retry).
 *   'post' — delegates first, then throws (simulates a response lost in transit,
 *             e.g. ECONNRESET on a keep-alive socket; only safe to retry for
 *             idempotent methods).
 */

import type { HttpPort, HttpRequest, HttpResponse } from '../ports/http.js';

// ─── mulberry32 PRNG ──────────────────────────────────────────────────────────

/**
 * mulberry32 — deterministic 32-bit PRNG seeded with an integer.
 * Returns a function that produces a float in [0, 1) on each call.
 */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── FlakyHttp ────────────────────────────────────────────────────────────────

export interface FlakyHttpOptions {
  /** PRNG seed for deterministic random failures. */
  seed: number;
  /** Probability of a random failure per request, in [0, 1). */
  rate: number;
  /** Error code to set on the thrown Error. Defaults to `'UND_ERR_CONNECT_TIMEOUT'`. */
  code?: string;
  /** Whether to fail before or after delegating. Defaults to `'pre'`. */
  mode?: 'pre' | 'post';
  /** Optional filter: if provided, only requests matching this predicate may fail. */
  match?: (req: HttpRequest) => boolean;
}

interface ExplicitFail {
  code: string;
  mode: 'pre' | 'post';
}

/**
 * `FlakyHttp` wraps another `HttpPort` and injects network failures.
 *
 * Failures are driven by two mechanisms:
 * 1. **Random** (PRNG seeded with `opts.seed`): each request has a `opts.rate`
 *    probability of failing. Deterministic — same seed produces same sequence.
 * 2. **Explicit** (`failNext`): enqueue N failures with a specific code and mode,
 *    consumed before random failures. Useful for deterministic unit tests.
 *
 * @example
 * const flaky = new FlakyHttp(fakeParche, { seed: 42, rate: 0.1 });
 * flaky.failNext(2, 'ECONNRESET', 'post');
 */
export class FlakyHttp implements HttpPort {
  private readonly rng: () => number;
  private readonly rate: number;
  private readonly defaultCode: string;
  private readonly defaultMode: 'pre' | 'post';
  private readonly matchFn: ((req: HttpRequest) => boolean) | undefined;
  private readonly queue: ExplicitFail[] = [];

  constructor(
    private readonly wrapped: HttpPort,
    opts: FlakyHttpOptions,
  ) {
    this.rng = mulberry32(opts.seed);
    this.rate = opts.rate;
    this.defaultCode = opts.code ?? 'UND_ERR_CONNECT_TIMEOUT';
    this.defaultMode = opts.mode ?? 'pre';
    this.matchFn = opts.match;
  }

  /**
   * Enqueue `n` explicit failures (consumed in order, before random failures).
   * Useful for deterministic tests that need precise control over when failures occur.
   */
  failNext(n: number, code: string, mode: 'pre' | 'post' = 'pre'): void {
    for (let i = 0; i < n; i++) {
      this.queue.push({ code, mode });
    }
  }

  private decide(req: HttpRequest): ExplicitFail | null {
    if (this.matchFn && !this.matchFn(req)) return null;

    // Explicit failures take priority over random
    if (this.queue.length > 0) {
      const explicit = this.queue.shift();
      if (explicit !== undefined) return explicit;
    }

    if (this.rng() < this.rate) {
      return { code: this.defaultCode, mode: this.defaultMode };
    }

    return null;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const fail = this.decide(req);

    if (fail === null) {
      return this.wrapped.request(req);
    }

    if (fail.mode === 'pre') {
      // Throw before delegating (connection never reached server)
      const err = new Error(fail.code) as Error & { code?: string };
      err.code = fail.code;
      throw err;
    }

    // mode === 'post': delegate first, then throw (response lost in transit)
    await this.wrapped.request(req);
    const err = new Error(fail.code) as Error & { code?: string };
    err.code = fail.code;
    throw err;
  }
}
