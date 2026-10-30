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

  /** HEAD /api/blob/:hash — check if blob exists for this group. */
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

  /** PUT /api/blob/:hash — upload a blob. Returns 200 (already existed) or 201 (created). */
  async putBlob(hash: string, data: Uint8Array, signal?: AbortSignal): Promise<void> {
    const res = await this.req({
      method: 'PUT',
      url: this.url(`/api/blob/${hash}`),
      headers: { ...this.authHeader(), 'Content-Type': 'application/octet-stream' },
      body: data,
      signal,
    });
    if (res.status === 200 || res.status === 201) return;
    const json = parseJson(res.body);
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
