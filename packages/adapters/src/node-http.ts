/**
 * adapters/node-http.ts — HttpPort implementation using node:http / node:https.
 *
 * Design decisions (CHAMBA-014 B1):
 * - One Agent({ keepAlive: true }) per protocol per NodeHttp instance (never the global agent).
 *   This lets tests create isolated instances and call .close() to release the TCP pool.
 * - Connect-timeout (default 5 s): set only when socket.connecting is true (new TCP connection;
 *   skipped when socket is reused from the keep-alive pool). Cleared on the 'connect' event,
 *   which fires when the TCP handshake completes for both http and https sockets. For TLS
 *   sockets (https), 'connect' = TCP established; TLS negotiation follows and is covered by the
 *   total timeout, not the connect-timeout. We chose 'connect' (TCP) rather than 'secureConnect'
 *   (TLS) because the incident we're protecting against is SYN loss (TCP-level), and clearing
 *   on TCP success is correct for that case.
 * - Total-timeout (default 30 s, overridable per-request via req.timeoutMs): on expiry the
 *   request is destroyed with an Error whose .code is 'ETIMEDOUT'. This is NOT an AbortError so
 *   RetryingHttp can distinguish a timed-out request from a caller-initiated abort.
 * - Caller signal (req.signal): if already aborted, rejects without connecting. Otherwise
 *   listens for 'abort'; on abort destroys the request and rejects with signal.reason
 *   (or DOMException 'AbortError') to match fetch() semantics.
 * - All timers and listeners are cleaned up in every code path.
 * - Body (Uint8Array | string) is sent with req.end(body) and a correct Content-Length.
 *   The original Uint8Array is not copied or mutated.
 * - Response is buffered to a Uint8Array. Header names are lowercased; arrays joined with ', '.
 * - Socket errors propagate with their original .code (ECONNRESET, ECONNREFUSED, …).
 */

import * as http from 'node:http';
import * as https from 'node:https';
import type { LookupFunction, Socket } from 'node:net';
import type { HttpPort, HttpRequest, HttpResponse } from '@chamba/core';

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 30_000;

const enc = new TextEncoder();

/** Node-backed `HttpPort` using `node:http` / `node:https` with keep-alive agents. */
export class NodeHttp implements HttpPort {
  private readonly httpAgent: http.Agent;
  private readonly httpsAgent: https.Agent;
  private readonly connectTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly lookup: LookupFunction | undefined;

  /**
   * @param totalTimeoutMs — total request timeout in ms (default 30 000).
   *   Kept as a positional number for backward compatibility
   *   (`new NodeHttp(50)` still works in existing tests).
   * @param connectTimeoutMs — TCP connect-timeout in ms (default 5 000).
   *   Only applied to new connections (skipped for reused keep-alive sockets). It covers DNS
   *   lookup + TCP handshake (`socket.connecting` is true for both).
   * @param opts.lookup — DNS lookup override (tests use it to simulate a connect that never
   *   completes, portably).
   */
  constructor(
    totalTimeoutMs: number = DEFAULT_TOTAL_TIMEOUT_MS,
    connectTimeoutMs: number = DEFAULT_CONNECT_TIMEOUT_MS,
    opts: { lookup?: LookupFunction } = {},
  ) {
    this.totalTimeoutMs = totalTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.lookup = opts.lookup;
    this.httpAgent = new http.Agent({ keepAlive: true });
    this.httpsAgent = new https.Agent({ keepAlive: true });
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    // Fast path: if already aborted, reject without connecting.
    if (req.signal?.aborted) {
      const reason = req.signal.reason;
      throw reason instanceof Error
        ? reason
        : new DOMException('The operation was aborted', 'AbortError');
    }

    const totalTimeoutMs = req.timeoutMs ?? this.totalTimeoutMs;
    const parsedUrl = new URL(req.url);
    const isHttps = parsedUrl.protocol === 'https:';
    const agent = isHttps ? this.httpsAgent : this.httpAgent;
    const mod: typeof http | typeof https = isHttps ? https : http;

    return new Promise<HttpResponse>((resolve, reject) => {
      let settled = false;
      let connectTimer: ReturnType<typeof setTimeout> | null = null;
      let totalTimer: ReturnType<typeof setTimeout> | null = null;
      let abortHandler: (() => void) | null = null;

      function cleanup(): void {
        if (connectTimer !== null) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        if (totalTimer !== null) {
          clearTimeout(totalTimer);
          totalTimer = null;
        }
        if (abortHandler !== null && req.signal) {
          req.signal.removeEventListener('abort', abortHandler);
          abortHandler = null;
        }
      }

      function fail(err: Error): void {
        if (settled) return;
        settled = true;
        cleanup();
        nodeReq.destroy();
        reject(err);
      }

      function succeed(res: HttpResponse): void {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(res);
      }

      // Prepare body
      let bodyBytes: Uint8Array | undefined;
      if (req.body instanceof Uint8Array) {
        bodyBytes = req.body;
      } else if (typeof req.body === 'string') {
        bodyBytes = enc.encode(req.body);
      }

      // Headers: lowercase the keys; add content-length if we have a body.
      const outHeaders: Record<string, string> = {};
      if (req.headers) {
        for (const [k, v] of Object.entries(req.headers)) {
          outHeaders[k.toLowerCase()] = v;
        }
      }
      if (bodyBytes !== undefined) {
        outHeaders['content-length'] = String(bodyBytes.byteLength);
      }

      const options: http.RequestOptions = {
        method: req.method,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port !== '' ? parsedUrl.port : isHttps ? '443' : '80',
        path: parsedUrl.pathname + parsedUrl.search,
        headers: outHeaders,
        agent,
        ...(this.lookup ? { lookup: this.lookup } : {}),
      };

      const nodeReq = mod.request(options);

      // ── Total timeout ────────────────────────────────────────────────────────
      totalTimer = setTimeout(() => {
        const err = new Error(
          `Request to ${parsedUrl.host} timed out after ${totalTimeoutMs} ms`,
        ) as Error & {
          code?: string;
        };
        err.code = 'ETIMEDOUT';
        fail(err);
      }, totalTimeoutMs);

      // ── Caller abort signal ──────────────────────────────────────────────────
      if (req.signal) {
        abortHandler = () => {
          const reason = req.signal?.reason;
          const abortErr =
            reason instanceof Error
              ? reason
              : new DOMException('The operation was aborted', 'AbortError');
          fail(abortErr as Error);
        };
        req.signal.addEventListener('abort', abortHandler);
      }

      // ── Socket event: connect-timeout for new connections ────────────────────
      nodeReq.on('socket', (socket: Socket) => {
        // Only arm a connect-timer for new (connecting) sockets.
        // Reused keep-alive sockets have socket.connecting === false.
        if (socket.connecting) {
          connectTimer = setTimeout(() => {
            const err = new Error(
              `Connect to ${parsedUrl.host} timed out after ${this.connectTimeoutMs} ms`,
            ) as Error & { code?: string };
            // Use the same code that the old fetch/undici path emitted so RetryingHttp
            // can classify it as a pre-send transient error.
            err.code = 'UND_ERR_CONNECT_TIMEOUT';
            fail(err);
          }, this.connectTimeoutMs);

          // Clear the connect-timer when TCP handshake completes ('connect' event).
          // For https (TLSSocket), 'connect' = TCP; TLS follows ('secureConnect').
          // We clear on TCP success because the timeout protects against SYN loss.
          socket.once('connect', () => {
            if (connectTimer !== null) {
              clearTimeout(connectTimer);
              connectTimer = null;
            }
          });
        }
        // No socket 'error' listener here: ClientRequest already forwards socket errors
        // (ECONNRESET, EPIPE, …) to nodeReq 'error', and keep-alive sockets are reused, so a
        // per-request listener would pile up on the same socket.
      });

      // ── Response handling ────────────────────────────────────────────────────
      nodeReq.on('response', (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          const bodyBuffer = Buffer.concat(chunks);
          const responseBody = new Uint8Array(bodyBuffer);

          // Lowercase all header names; join arrays with ', '.
          const responseHeaders: Record<string, string> = {};
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            responseHeaders[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
          }

          succeed({
            status: res.statusCode ?? 0,
            headers: responseHeaders,
            body: responseBody,
          });
        });
        res.on('error', (err: Error) => {
          fail(err);
        });
      });

      // ── Request-level errors ─────────────────────────────────────────────────
      nodeReq.on('error', (err: Error) => {
        fail(err);
      });

      // ── Send body ────────────────────────────────────────────────────────────
      if (bodyBytes !== undefined) {
        nodeReq.end(bodyBytes);
      } else {
        nodeReq.end();
      }
    });
  }

  /**
   * Destroy both keep-alive agents, releasing all pooled sockets.
   * Call this at the end of tests (or when the process shuts down) to avoid
   * lingering handles that prevent the event loop from exiting.
   */
  close(): void {
    this.httpAgent.destroy();
    this.httpsAgent.destroy();
  }

  /** Alias for close(). */
  destroy(): void {
    this.close();
  }
}
