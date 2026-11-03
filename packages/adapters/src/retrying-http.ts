/*
 * adapters/retrying-http.ts — HttpPort decorator with exponential backoff + retry.
 *
 * Design (CHAMBA-014 B2):
 *
 * Transient error codes that trigger a retry:
 *   UND_ERR_CONNECT_TIMEOUT — emitted by NodeHttp on connect-timeout (pre-send).
 *   UND_ERR_SOCKET, UND_ERR_HEADERS_TIMEOUT, UND_ERR_BODY_TIMEOUT — defensive;
 *     NodeHttp no longer uses fetch/undici, but left in case another HttpPort does.
 *   ECONNRESET, ECONNREFUSED, ETIMEDOUT, EPIPE, EAI_AGAIN, ENETUNREACH, EHOSTUNREACH
 *
 * Transient HTTP statuses: 502, 503, 504.
 * 429 with Retry-After header (seconds or HTTP-date; capped at retryAfterCapMs).
 *
 * Method/route policy (closed decision, idempotency verified against parche §3):
 *   GET            — retries on any transient.
 *   PUT /api/blob/* — retries on any transient (blobs are content-addressed; PUT is idempotent).
 *   POST .../push  — retries on any transient (push is idempotent: server responds 'ok' with the
 *                    existing seq when newHash===head, even for tombstones — see push.ts).
 *   POST /api/join — retries ONLY on pre-send codes (ECONNREFUSED, EAI_AGAIN, ENETUNREACH,
 *                    EHOSTUNREACH, UND_ERR_CONNECT_TIMEOUT): a join sent-and-received could
 *                    consume an invite code or create a duplicate member (409).
 *   Other          — retries only on pre-send codes (conservative).
 *
 * Non-retryable:
 *   AbortError / caller abort (req.signal?.aborted) → re-thrown as-is, never wrapped.
 *   Errors without a transient code (BlobHashMismatchError, validation errors, …) → re-thrown.
 *   HTTP 4xx other than 429 → returned to the caller as-is.
 *   Any HTTP response for POST /api/join (incl. 429, 5xx) → returned, never retried.
 *
 * On exhaustion:
 *   After all attempts fail with retryable network errors → throws ParcheNetworkError.
 *   After all attempts fail with retryable 5xx/429 → returns the last HTTP response.
 *
 * Backoff: wait = random() * min(capMs, baseMs * 2^(attempt - 1))  (full jitter).
 *
 * The sleep function is abortable: it rejects immediately (as AbortError) when the
 * caller's signal fires. No timers survive the end of the request.
 *
 * The same req object (including the same Uint8Array body) is forwarded on every attempt.
 *
 * Log (per retry): `logger.debug({ method, path, attempt, code_or_status, waitMs }, 'parche: reintento')`.
 * Never logs headers, full URL, body or cause.
 */

import type { HttpPort, HttpRequest, HttpResponse } from '@chamba/core';
import { ParcheNetworkError } from '@chamba/core';

// ─── Transient error-code sets ────────────────────────────────────────────────

/** All codes that may indicate a transient failure worth retrying. */
const TRANSIENT_CODES = new Set([
  // UND_ERR_* are defensive (NodeHttp no longer uses fetch/undici directly),
  // except UND_ERR_CONNECT_TIMEOUT which NodeHttp emits for connect-timeouts.
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  // OS-level / DNS errors
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

/**
 * Pre-send codes: failures that happened before the request body was sent,
 * so they are safe to retry for ANY method (including POST /api/join).
 */
const PRE_SEND_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
]);

/** HTTP statuses that are always retryable (server-side overload / gateway issues). */
const TRANSIENT_STATUSES = new Set([502, 503, 504]);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const e = err as Error & { code?: string; cause?: unknown };
  if (e.code) return e.code;
  const cause = e.cause as (Error & { code?: string }) | undefined;
  return cause?.code;
}

function isAbortError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || (err instanceof DOMException && err.name === 'AbortError');
}

/**
 * Returns true if the error code is one of the transient codes we classify as safe to retry.
 */
function isTransientCode(code: string | undefined): boolean {
  return code !== undefined && TRANSIENT_CODES.has(code);
}

/**
 * Returns true if the error is retryable for the given method + pathname.
 * Assumes the error has already been classified as having a transient code.
 */
function isRetryableForMethod(method: string, pathname: string, code: string): boolean {
  const m = method.toUpperCase();

  // POST /api/join: only safe to retry on pre-send codes (never on post-send errors,
  // since a join that was received might have already consumed the invite code).
  if (m === 'POST' && pathname === '/api/join') {
    return PRE_SEND_CODES.has(code);
  }

  // GET: always retryable (idempotent by definition).
  if (m === 'GET') return true;

  // PUT /api/blob/*: blobs are content-addressed and PUT is idempotent (200 if already existed).
  if (m === 'PUT' && pathname.startsWith('/api/blob/')) return true;

  // POST */push: the parche push endpoint is idempotent (parche/src/routes/push.ts):
  //   if the row exists and newHash === head, it responds 'ok' with the existing seq.
  //   A lost response is safe to retry.
  if (m === 'POST' && pathname.endsWith('/push')) return true;

  // Other methods: only pre-send codes (conservative).
  return PRE_SEND_CODES.has(code);
}

/**
 * Parse a Retry-After header value (seconds or HTTP-date).
 * Returns the wait in ms, capped to `capMs`, or null if unparseable.
 */
function parseRetryAfter(header: string | undefined, capMs: number): number | null {
  if (!header) return null;

  // Try as non-negative number (seconds).
  const secs = Number(header.trim());
  if (!Number.isNaN(secs) && secs >= 0) {
    return Math.min(Math.round(secs * 1000), capMs);
  }

  // Try as HTTP-date.
  try {
    const date = new Date(header);
    if (!Number.isNaN(date.getTime())) {
      const ms = date.getTime() - Date.now();
      if (ms > 0) return Math.min(ms, capMs);
      return 0;
    }
  } catch {
    // Ignore parse errors
  }

  return null;
}

/**
 * Produce a short (≤ 120 char) human-readable summary of an error cause.
 * Strips: query strings (?...), parche tokens (pch_[A-Za-z0-9_-]+).
 * Uses only the first line of the message.
 */
function buildShortMessage(cause: unknown): string {
  let msg = '';
  if (cause instanceof Error) {
    msg = cause.message.split('\n')[0] ?? '';
  } else if (typeof cause === 'string') {
    msg = cause.split('\n')[0] ?? '';
  }
  // Strip query strings (anything from '?' to end of word / parenthesis)
  msg = msg.replace(/\?[^\s)"]*/g, '');
  // Strip parche tokens
  msg = msg.replace(/pch_[A-Za-z0-9_-]+/g, '[token]');
  return msg.slice(0, 120).trim();
}

/**
 * Default abortable sleep. Rejects with DOMException 'AbortError' if the signal
 * fires during the wait. Guarantees no timers remain after settling.
 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('The operation was aborted', 'AbortError'));
      return;
    }

    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);

    function onAbort(): void {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(new DOMException('The operation was aborted', 'AbortError'));
    }

    if (signal) {
      signal.addEventListener('abort', onAbort);
    }
  });
}

// ─── RetryingHttpOptions ──────────────────────────────────────────────────────

export interface RetryingHttpOptions {
  /** Maximum number of attempts (default 4). */
  maxAttempts?: number;
  /** Base backoff in ms (default 300). */
  baseMs?: number;
  /** Cap on computed backoff in ms (default 3 000). */
  capMs?: number;
  /** Cap on Retry-After header wait in ms (default 10 000). */
  retryAfterCapMs?: number;
  /** Replaceable sleep for testing. Default is an abortable setTimeout. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Replaceable random source for jitter (default Math.random). */
  random?: () => number;
  /** Optional logger (e.g. pino). Only debug() is called, never with sensitive data. */
  logger?: { debug(obj: object, msg?: string): void };
}

// ─── RetryingHttp ─────────────────────────────────────────────────────────────

/** `HttpPort` decorator that retries transient network errors with exponential backoff. */
export class RetryingHttp implements HttpPort {
  private readonly inner: HttpPort;
  private readonly maxAttempts: number;
  private readonly baseMs: number;
  private readonly capMs: number;
  private readonly retryAfterCapMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly logger: { debug(obj: object, msg?: string): void } | undefined;

  constructor(inner: HttpPort, opts: RetryingHttpOptions = {}) {
    this.inner = inner;
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.baseMs = opts.baseMs ?? 300;
    this.capMs = opts.capMs ?? 3_000;
    this.retryAfterCapMs = opts.retryAfterCapMs ?? 10_000;
    this.sleep = opts.sleep ?? defaultSleep;
    this.random = opts.random ?? (() => Math.random());
    this.logger = opts.logger;
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    // Abort check before we begin.
    if (req.signal?.aborted) {
      const reason = req.signal.reason;
      throw reason instanceof Error
        ? reason
        : new DOMException('The operation was aborted', 'AbortError');
    }

    const url = new URL(req.url);
    const method = req.method.toUpperCase();
    const pathname = url.pathname;

    let lastError: unknown;
    let lastResponse: HttpResponse | undefined;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      // Abort check before each attempt.
      if (req.signal?.aborted) {
        const reason = req.signal.reason;
        throw reason instanceof Error
          ? reason
          : new DOMException('The operation was aborted', 'AbortError');
      }

      let response: HttpResponse;

      try {
        response = await this.inner.request(req);
      } catch (err) {
        // Caller abort is never retried nor wrapped — re-throw as-is, whatever the inner error.
        if (isAbortError(err) || req.signal?.aborted) throw err;

        const code = getCode(err);
        const transient = isTransientCode(code);

        if (!transient) {
          // Error without a transient code (validation error, BlobHashMismatchError, …):
          // propagate without wrapping.
          throw err;
        }

        const canRetry = code !== undefined && isRetryableForMethod(method, pathname, code);

        if (!canRetry) {
          // Transient error, but the method does not allow a retry (e.g. join ECONNRESET
          // post-send): wrap as ParcheNetworkError and surface immediately.
          throw new ParcheNetworkError({
            url: req.url,
            attempts: attempt,
            code: code ?? 'UNKNOWN',
            shortMessage: buildShortMessage(err),
            cause: err,
          });
        }

        if (attempt >= this.maxAttempts) {
          lastError = err;
          break; // Will throw ParcheNetworkError below.
        }

        const waitMs = Math.round(
          this.random() * Math.min(this.capMs, this.baseMs * 2 ** (attempt - 1)),
        );
        this.logger?.debug({ method, path: pathname, attempt, code, waitMs }, 'parche: reintento');
        await this.sleep(waitMs, req.signal);
        lastError = err;
        continue;
      }

      // We have an HTTP response. Check for retryable statuses.
      const { status } = response;
      const isRetryableStatus = TRANSIENT_STATUSES.has(status) || status === 429;

      if (!isRetryableStatus) {
        // 2xx, 4xx (non-429), 1xx, 3xx — return immediately.
        return response;
      }

      // For POST /api/join, never retry any HTTP response (including 429 / 5xx).
      const isJoin = method === 'POST' && pathname === '/api/join';
      if (isJoin) {
        return response;
      }

      // Retryable status, but we've used all attempts.
      if (attempt >= this.maxAttempts) {
        lastResponse = response;
        break;
      }

      // Calculate wait. For 429, honor Retry-After if present.
      let waitMs: number;
      if (status === 429) {
        const retryAfter = response.headers['retry-after'];
        const fromHeader = parseRetryAfter(retryAfter, this.retryAfterCapMs);
        waitMs =
          fromHeader !== null
            ? fromHeader
            : Math.round(this.random() * Math.min(this.capMs, this.baseMs * 2 ** (attempt - 1)));
      } else {
        waitMs = Math.round(this.random() * Math.min(this.capMs, this.baseMs * 2 ** (attempt - 1)));
      }

      this.logger?.debug({ method, path: pathname, attempt, status, waitMs }, 'parche: reintento');
      lastResponse = response;
      await this.sleep(waitMs, req.signal);
    }

    // If we exited the loop because of exhausted network-error retries → ParcheNetworkError.
    if (lastError !== undefined) {
      const code = getCode(lastError);
      throw new ParcheNetworkError({
        url: req.url,
        attempts: this.maxAttempts,
        code: code ?? 'UNKNOWN',
        shortMessage: buildShortMessage(lastError),
        cause: lastError,
      });
    }

    // Exhausted retries on 5xx/429 → return the last response (caller converts it to ParcheHttpError).
    if (lastResponse !== undefined) {
      return lastResponse;
    }

    // Should be unreachable.
    throw new Error('RetryingHttp: unexpected state after retry loop');
  }
}
