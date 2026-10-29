/**
 * adapters/node-http.ts — HttpPort implementation using global fetch.
 * Uses AbortController for timeout (default 30 s), combined with caller's signal.
 */

import type { HttpPort, HttpRequest, HttpResponse } from '@chamba/core';

const DEFAULT_TIMEOUT_MS = 30_000;

/** Node-backed `HttpPort` using global `fetch` (Node 22+). */
export class NodeHttp implements HttpPort {
  constructor(private readonly defaultTimeoutMs: number = DEFAULT_TIMEOUT_MS) {}

  async request(req: HttpRequest): Promise<HttpResponse> {
    const timeoutMs = req.timeoutMs ?? this.defaultTimeoutMs;

    // Create a timeout controller
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);

    // Combine caller signal (if any) with the timeout signal
    let signal: AbortSignal;
    if (req.signal) {
      // AbortSignal.any combines multiple signals (Node 20+)
      signal = AbortSignal.any([req.signal, timeoutController.signal]);
    } else {
      signal = timeoutController.signal;
    }

    try {
      let body: Uint8Array | string | undefined;
      if (req.body instanceof Uint8Array) {
        body = req.body;
      } else if (typeof req.body === 'string') {
        body = req.body;
      }

      const response = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body,
        signal,
      });

      const buffer = await response.arrayBuffer();
      const responseBody = new Uint8Array(buffer);

      // Convert Headers to a plain object
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      return {
        status: response.status,
        headers,
        body: responseBody,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
