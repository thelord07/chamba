/**
 * ports/http.ts — HTTP port for @chamba/core.
 * Pure: no Node imports. The Node implementation lives in @chamba/adapters.
 */

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  timeoutMs?: number;
  /** Caller-supplied abort signal, combined with the adapter's timeout signal. */
  signal?: AbortSignal;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * HTTP port. The adapter implementation uses global `fetch` + AbortController.
 * A fake implementation lives in `@chamba/core/testing`.
 */
export interface HttpPort {
  request(req: HttpRequest): Promise<HttpResponse>;
}
