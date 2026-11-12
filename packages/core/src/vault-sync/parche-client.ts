/**
 * vault-sync/parche-client.ts — typed wrapper over HttpPort for the parche API.
 * Pure: no Node imports. Uses schemas from protocol.ts for validation.
 */

import { z } from 'zod';
import type { HttpPort, HttpRequest } from '../ports/http.js';
import type { PushEntry } from './plan.js';
import type { ChangesResponse, JoinRequest, JoinResponse, PushResponse } from './protocol.js';
import {
  changesResponseSchema,
  joinResponseSchema,
  PROTOCOL_VERSION,
  pushRequestSchema,
  pushResponseSchema,
} from './protocol.js';

// ─── checkInvite types (PARCHE-011) ──────────────────────────────────────────

export type CheckInviteResult =
  | { status: 'valid'; slug: string; name: string }
  | { status: 'invalid' }
  | { status: 'not-found' }
  | { status: 'network-error'; message: string };

const checkInviteResponseSchema = z.object({
  valid: z.boolean(),
  group: z
    .object({
      name: z.string(),
      slug: z.string(),
    })
    .optional(),
});

// ─── Error types ──────────────────────────────────────────────────────────────

export class ParcheHttpError extends Error {
  override name = 'ParcheHttpError';
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
  }
}

export class ParcheNotFoundError extends ParcheHttpError {
  override name = 'ParcheNotFoundError';
}

export class ParcheAlreadyMemberError extends ParcheHttpError {
  override name = 'ParcheAlreadyMemberError';
}

export class ParcheRateLimitedError extends ParcheHttpError {
  override name = 'ParcheRateLimitedError';
}

export class ParcheMissingBlobsError extends ParcheHttpError {
  override name = 'ParcheMissingBlobsError';
  constructor(
    status: number,
    body: unknown,
    public readonly hashes: string[],
  ) {
    super(status, body, `Missing blobs: ${hashes.join(', ')}`);
  }
}

export class ParcheCaseCollisionError extends ParcheHttpError {
  override name = 'ParcheCaseCollisionError';
  constructor(
    status: number,
    body: unknown,
    public readonly path: string,
    public readonly existing: string,
  ) {
    super(status, body, `Case collision: ${path} conflicts with ${existing}`);
  }
}

/**
 * CHAMBA-023 S2: thrown when `PUT /api/blob/:hash` returns
 * `422 {error: 'secret_detected', kinds}` — the server's own secret scan
 * rejected this blob's content, independent of the client's allowlist (the
 * client already sent every fingerprint it has allowlisted for this content
 * via `X-Parche-Secret-Allow`; the server still found something it did not
 * recognize as covered). `kinds` is the server's classification (e.g.
 * `['assignment', 'stripe-secret-key']`) — never the value, never a
 * fingerprint (the server protocol does not return one, see CHAMBA-023 plan
 * §1 Open question 4). The message never includes the path or the value —
 * callers attach path/line context themselves (see `messages.ts`).
 */
export class ParcheSecretDetectedError extends ParcheHttpError {
  override name = 'ParcheSecretDetectedError';
  constructor(
    status: number,
    body: unknown,
    public readonly kinds: string[],
  ) {
    super(status, body, `Blob rejected: secret_detected (${kinds.join(', ')})`);
  }
}

/**
 * Thrown by RetryingHttp (adapters) when a network operation fails after all
 * retry attempts. Never includes query strings, headers, token or body — only
 * the host (from URL), attempt count, error code and a short human-readable
 * message.
 *
 * Note: `host` is extracted from the URL with `new URL(url).host`. If the URL
 * is malformed, `host` falls back to `'<desconocido>'`. The raw URL (which may
 * contain query params or tokens) is never stored.
 */
export class ParcheNetworkError extends Error {
  override name = 'ParcheNetworkError';
  /** URL host (port only if non-default; never path or query). */
  readonly host: string;
  /** Total attempts made before giving up. */
  readonly attempts: number;
  /** OS / undici error code, e.g. `'ECONNRESET'`, `'UND_ERR_CONNECT_TIMEOUT'`. */
  readonly code: string;
  /** Short human-readable description of the error. */
  readonly shortMessage: string;
  override readonly cause: unknown;

  constructor(opts: {
    url: string;
    attempts: number;
    code: string;
    shortMessage: string;
    cause?: unknown;
  }) {
    const plural = opts.attempts === 1 ? 'intento' : 'intentos';
    super(
      `parche: no se pudo conectar tras ${opts.attempts} ${plural} (${opts.code}: ${opts.shortMessage})`,
    );
    let host: string;
    try {
      host = new URL(opts.url).host;
    } catch {
      host = '<desconocido>';
    }
    this.host = host;
    this.attempts = opts.attempts;
    this.code = opts.code;
    this.shortMessage = opts.shortMessage;
    this.cause = opts.cause;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function bodyText(body: Uint8Array): string {
  return decoder.decode(body);
}

function parseJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(bodyText(body));
  } catch {
    return null;
  }
}

// ─── X-Parche-Secret-Allow header (CHAMBA-023 S2) ─────────────────────────────

/** HTTP header carrying the fingerprints already allowlisted for this blob's content. */
export const SECRET_ALLOW_HEADER = 'X-Parche-Secret-Allow';

/** A fingerprint is always 12 lowercase hex chars (`fingerprintOf` in scanner.ts). */
const FINGERPRINT_RE = /^[0-9a-f]{12}$/;

/** Max byte length of the `X-Parche-Secret-Allow` header VALUE (CHAMBA-023 plan §1.4, D-Q4). */
const MAX_HEADER_BYTES = 4096;

/**
 * Build the `X-Parche-Secret-Allow` header value from a list of fingerprints.
 *
 * Defense in depth (CHAMBA-023 plan §1.5): `secret-allowlist.json` is a
 * user-editable file whose `fingerprint` field is `z.string().min(1)` — not
 * constrained to the 12-hex-char shape fingerprints actually have. If a
 * caller ever passed allowlist-derived strings straight through, a value
 * containing `\r\n` would be a header-injection vector. Only strings matching
 * `/^[0-9a-f]{12}$/` are allowed through; everything else is silently
 * dropped (fail-closed: a dropped fingerprint just means that finding is
 * treated as NOT exempted by the server, which is always safe).
 *
 * Deterministic: deduplicated, then sorted ascending (makes tests and any
 * byte-level comparison stable). Truncated so the joined value never exceeds
 * `MAX_HEADER_BYTES` — fail-closed by construction (plan §1.4): a truncated
 * list is a SUBSET of what's really allowlisted, so the server either
 * accepts (fine) or 422s for the fingerprints that didn't fit, which is
 * handled by `ParcheSecretDetectedError` like any other divergence, never an
 * unintended upload.
 *
 * Returns `undefined` when there is nothing valid to send (caller omits the
 * header entirely).
 */
function buildSecretAllowHeaderValue(fingerprints: readonly string[]): string | undefined {
  const valid = [...new Set(fingerprints.filter((fp) => FINGERPRINT_RE.test(fp)))].sort();
  if (valid.length === 0) return undefined;

  let value = '';
  for (const fp of valid) {
    const candidate = value.length === 0 ? fp : `${value},${fp}`;
    if (encoder.encode(candidate).byteLength > MAX_HEADER_BYTES) break;
    value = candidate;
  }
  return value.length > 0 ? value : undefined;
}

/** Defensive parse of the `kinds` array from a `422 secret_detected` body. */
function parseSecretDetectedKinds(json: unknown): string[] {
  if (json === null || typeof json !== 'object') return [];
  const kinds = (json as { kinds?: unknown }).kinds;
  if (!Array.isArray(kinds)) return [];
  return kinds.filter((k): k is string => typeof k === 'string');
}

// ─── ParcheClient ─────────────────────────────────────────────────────────────

export class ParcheClient {
  constructor(
    private readonly http: HttpPort,
    private readonly server: string,
    private readonly token: string,
  ) {}

  private authHeader(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}` };
  }

  private url(path: string): string {
    return `${this.server}${path}`;
  }

  private async req(req: HttpRequest) {
    return this.http.request(req);
  }

  /** POST /api/join — create a device and join a group. */
  async join(body: JoinRequest, signal?: AbortSignal): Promise<JoinResponse> {
    const res = await this.req({
      method: 'POST',
      url: this.url('/api/join'),
      headers: { 'Content-Type': 'application/json' },
      body: encoder.encode(JSON.stringify(body)),
      signal,
    });

    const json = parseJson(res.body);

    if (res.status === 200) {
      const parsed = joinResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new ParcheHttpError(200, json, `Invalid join response: ${parsed.error.message}`);
      }
      return parsed.data;
    }
    if (res.status === 404) {
      throw new ParcheNotFoundError(404, json, 'Invite code invalid, expired or exhausted');
    }
    if (res.status === 409) {
      throw new ParcheAlreadyMemberError(
        409,
        json,
        'Already a member of this group (coming soon: vault login for existing members)',
      );
    }
    if (res.status === 429) {
      throw new ParcheRateLimitedError(429, json, 'Too many attempts, please wait a minute');
    }
    throw new ParcheHttpError(res.status, json, `Unexpected join response: ${res.status}`);
  }

  /** GET /api/g/:slug/changes?since=<cursor>&limit=500 */
  async getChanges(slug: string, since: number, signal?: AbortSignal): Promise<ChangesResponse> {
    const res = await this.req({
      method: 'GET',
      url: this.url(`/api/g/${slug}/changes?since=${since}&limit=500`),
      headers: this.authHeader(),
      signal,
    });

    const json = parseJson(res.body);

    if (res.status === 200) {
      const parsed = changesResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new ParcheHttpError(200, json, `Invalid changes response: ${parsed.error.message}`);
      }
      return parsed.data;
    }
    throw new ParcheHttpError(res.status, json, `Unexpected changes response: ${res.status}`);
  }

  /**
   * HEAD /api/blob/:hash — check if blob exists for this group.
   *
   * Not used in the sync path (CHAMBA-014): `pushAll` uses a push-first strategy
   * and only uploads blobs reported as missing by the server (422). This method
   * is kept for tooling or diagnostics outside the sync path.
   */
  async headBlob(hash: string, signal?: AbortSignal): Promise<boolean> {
    const res = await this.req({
      method: 'HEAD',
      url: this.url(`/api/blob/${hash}`),
      headers: this.authHeader(),
      signal,
    });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    const json = parseJson(res.body);
    throw new ParcheHttpError(res.status, json, `Unexpected HEAD blob response: ${res.status}`);
  }

  /**
   * PUT /api/blob/:hash — upload a blob. Returns 200 (already existed) or 201 (created).
   *
   * CHAMBA-023 S2: `opts.allowFingerprints` lists the fingerprints the LOCAL
   * gate already allowlisted for THIS content (computed by `screenPushEntries`,
   * see secret-gate.ts) — never the full allowlist, never another path's
   * fingerprints. Sent via `X-Parche-Secret-Allow` so the server's own secret
   * scan can skip findings the user already reviewed. The header is omitted
   * entirely when there is nothing valid to send.
   *
   * A `422 {error: 'secret_detected', kinds}` response (the server found an
   * un-exempted secret) throws `ParcheSecretDetectedError`, distinct from
   * every other 4xx/5xx (still `ParcheHttpError`, unchanged).
   */
  async putBlob(
    hash: string,
    data: Uint8Array,
    signal?: AbortSignal,
    opts?: { allowFingerprints?: readonly string[] },
  ): Promise<void> {
    const headerValue = buildSecretAllowHeaderValue(opts?.allowFingerprints ?? []);
    const res = await this.req({
      method: 'PUT',
      url: this.url(`/api/blob/${hash}`),
      headers: {
        ...this.authHeader(),
        'Content-Type': 'application/octet-stream',
        ...(headerValue !== undefined ? { [SECRET_ALLOW_HEADER]: headerValue } : {}),
      },
      body: data,
      signal,
    });
    if (res.status === 200 || res.status === 201) return;
    const json = parseJson(res.body);
    if (
      res.status === 422 &&
      json !== null &&
      typeof json === 'object' &&
      (json as { error?: unknown }).error === 'secret_detected'
    ) {
      throw new ParcheSecretDetectedError(422, json, parseSecretDetectedKinds(json));
    }
    throw new ParcheHttpError(res.status, json, `Unexpected PUT blob response: ${res.status}`);
  }

  /** GET /api/blob/:hash — download a blob. */
  async getBlob(hash: string, signal?: AbortSignal): Promise<Uint8Array> {
    const res = await this.req({
      method: 'GET',
      url: this.url(`/api/blob/${hash}`),
      headers: this.authHeader(),
      signal,
    });
    if (res.status === 200) return res.body;
    const json = parseJson(res.body);
    throw new ParcheHttpError(res.status, json, `Unexpected GET blob response: ${res.status}`);
  }

  /**
   * GET /api/web/invites/:code/check — non-consuming invite pre-check (PARCHE-011 R4/R12/R13).
   * Returns a discriminated result; never throws.
   */
  static async checkInvite(
    http: HttpPort,
    serverUrl: string,
    code: string,
  ): Promise<CheckInviteResult> {
    try {
      const res = await http.request({
        method: 'GET',
        url: `${serverUrl}/api/web/invites/${encodeURIComponent(code)}/check`,
        headers: {},
        timeoutMs: 10_000,
      });

      const json = parseJson(res.body);

      if (res.status === 200) {
        const parsed = checkInviteResponseSchema.safeParse(json);
        if (!parsed.success) {
          return { status: 'network-error', message: `respuesta inválida del servidor` };
        }
        if (!parsed.data.valid) return { status: 'invalid' };
        const group = parsed.data.group;
        if (!group) {
          return { status: 'network-error', message: 'respuesta sin datos de grupo' };
        }
        return { status: 'valid', slug: group.slug, name: group.name };
      }

      if (res.status === 404) return { status: 'not-found' };

      // 429, 5xx, unexpected
      return {
        status: 'network-error',
        message: `servidor respondió ${res.status}`,
      };
    } catch (err) {
      return {
        status: 'network-error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** POST /api/g/:slug/push — push a batch of changes (≤500). */
  async push(slug: string, entries: PushEntry[], signal?: AbortSignal): Promise<PushResponse> {
    const body = pushRequestSchema.parse({ protocol: PROTOCOL_VERSION, changes: entries });
    const res = await this.req({
      method: 'POST',
      url: this.url(`/api/g/${slug}/push`),
      headers: { ...this.authHeader(), 'Content-Type': 'application/json' },
      body: encoder.encode(JSON.stringify(body)),
      signal,
    });

    const json = parseJson(res.body);

    if (res.status === 200) {
      const parsed = pushResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new ParcheHttpError(200, json, `Invalid push response: ${parsed.error.message}`);
      }
      return parsed.data;
    }

    if (res.status === 422) {
      const hashes =
        json !== null &&
        typeof json === 'object' &&
        'hashes' in (json as object) &&
        Array.isArray((json as { hashes: unknown }).hashes)
          ? ((json as { hashes: string[] }).hashes as string[])
          : [];
      throw new ParcheMissingBlobsError(422, json, hashes);
    }

    if (res.status === 409) {
      const path =
        json !== null && typeof json === 'object' && 'path' in (json as object)
          ? String((json as { path: unknown }).path)
          : '';
      const existing =
        json !== null && typeof json === 'object' && 'existing' in (json as object)
          ? String((json as { existing: unknown }).existing)
          : '';
      throw new ParcheCaseCollisionError(409, json, path, existing);
    }

    throw new ParcheHttpError(res.status, json, `Unexpected push response: ${res.status}`);
  }
}
