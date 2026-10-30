/**
 * testing/fake-parche.ts — in-memory HttpPort that mirrors the parche server.
 * No node: imports. Uses ClockPort for latency simulation.
 *
 * Implements:
 *   POST /api/join
 *   GET  /api/g/:slug/changes?since&limit
 *   POST /api/g/:slug/push
 *   HEAD /api/blob/:hash
 *   GET  /api/blob/:hash
 *   PUT  /api/blob/:hash
 *
 * Knobs:
 *   pageLimit            — max changes per page (default 500)
 *   failChangesPage      — fail on this page number (1-based)
 *   corruptBlob(hash)    — make GET return wrong bytes
 *   rejectPushBlobs(hashes) — make push always 422 for these hashes
 *   latencyMs            — simulate latency via clock.sleep
 */

import type { ClockPort } from '../ports/clock.js';
import type { HttpPort, HttpRequest, HttpResponse } from '../ports/http.js';
import { pathKey } from '../vault-sync/path-key.js';
import type {
  ChangeEntry,
  ChangesResponse,
  JoinResponse,
  PushChange,
  Role,
} from '../vault-sync/protocol.js';
import {
  changesResponseSchema,
  joinRequestSchema,
  joinResponseSchema,
  PROTOCOL_VERSION,
  pushRequestSchema,
  pushResponseSchema,
} from '../vault-sync/protocol.js';
import { isSyncable } from '../vault-sync/sync-filter.js';

// ─── Internal helpers ─────────────────────────────────────────────────────────

const enc = new TextEncoder();
const dec = new TextDecoder();

function json(data: unknown, status = 200): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: enc.encode(JSON.stringify(data)),
  };
}

function err(status: number, error: string, extra?: Record<string, unknown>): HttpResponse {
  return json({ error, ...extra }, status);
}

function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ─── Internal state ───────────────────────────────────────────────────────────

interface GroupRecord {
  id: string;
  slug: string;
  name: string;
}

interface MemberRecord {
  userId: string;
  role: Role;
}

interface DeviceRecord {
  id: string;
  userId: string;
  groupId: string;
  label: string;
  token: string;
}

interface UserRecord {
  id: string;
  name: string;
  email: string;
}

interface InviteRecord {
  code: string;
  groupId: string;
  role: Role;
  maxUses: number | null;
  uses: number;
}

// ─── FakeParche ───────────────────────────────────────────────────────────────

export class FakeParche implements HttpPort {
  // ── Knobs ───────────────────────────────────────────────────────────────────
  pageLimit = 500;
  failChangesPage: number | null = null;
  latencyMs = 0;
  /** When true, POST /api/join returns 429 */
  rateLimitJoin = false;

  private readonly corruptedBlobs = new Set<string>();
  private readonly rejectedPushBlobs = new Set<string>();
  private readonly rejectedPushBlobsOnce = new Map<string, number>(); // hash → remaining rejections
  // Track total requests per path for test assertions
  readonly requestLog: Array<{ method: string; url: string }> = [];
  // Last captured join request body
  lastJoinRequest: Record<string, unknown> | null = null;
  // Whether the abort signal was already aborted when the last request arrived
  lastSignalWasAborted = false;

  // ── PARCHE-011: checkInvite knobs ──────────────────────────────────────────
  /** When set, GET /api/web/invites/:code/check returns this fixed result instead of the default. */
  checkInviteOverride: null | { status: number; body: unknown } | 'throw' = null;

  corruptBlob(hash: string): void {
    this.corruptedBlobs.add(hash);
  }

  rejectPushBlobs(hashes: string[]): void {
    for (const h of hashes) this.rejectedPushBlobs.add(h);
  }

  /**
   * Make the FIRST push request return 422 for these hashes.
   * After one rejection the hash is cleared (transient failure).
   */
  rejectPushBlobsOnce(hashes: string[]): void {
    for (const h of hashes) {
      this.rejectedPushBlobsOnce.set(h, (this.rejectedPushBlobsOnce.get(h) ?? 0) + 1);
    }
  }

  // ── Internal state ──────────────────────────────────────────────────────────
  private readonly groups = new Map<string, GroupRecord>();
  private readonly users = new Map<string, UserRecord>(); // id → user
  private readonly usersByEmail = new Map<string, UserRecord>(); // email → user
  private readonly members = new Map<string, Map<string, MemberRecord>>(); // groupId → userId → member
  private readonly devices = new Map<string, DeviceRecord>(); // token → device
  private readonly invites = new Map<string, InviteRecord>(); // code → invite
  private readonly blobs = new Map<string, Uint8Array>(); // hash → bytes
  private readonly blobRefs = new Map<string, Set<string>>(); // groupId → Set<hash>
  // changes: groupId → sorted array
  private readonly changes = new Map<string, ChangeEntry[]>();
  // files: groupId → pathKey → { path, hash | null, seq }
  private readonly files = new Map<
    string,
    Map<string, { path: string; hash: string | null; seq: number }>
  >();

  private seqCounter = 0;
  // Track page requests for failChangesPage (per group, global counter)
  private changesPageCount = new Map<string, number>(); // groupId → total request count

  constructor(private readonly clock: ClockPort) {}

  // ── Seed helpers ────────────────────────────────────────────────────────────

  seedGroup(opts: { id?: string; slug: string; name?: string }): GroupRecord {
    const group: GroupRecord = {
      id: opts.id ?? newId(),
      slug: opts.slug,
      name: opts.name ?? opts.slug,
    };
    this.groups.set(group.id, group);
    this.members.set(group.id, new Map());
    this.changes.set(group.id, []);
    this.files.set(group.id, new Map());
    this.blobRefs.set(group.id, new Set());
    return group;
  }

  addInvite(opts: { code: string; groupId: string; role?: Role; maxUses?: number | null }): void {
    this.invites.set(opts.code.toUpperCase(), {
      code: opts.code.toUpperCase(),
      groupId: opts.groupId,
      role: opts.role ?? 'editor',
      maxUses: opts.maxUses ?? null,
      uses: 0,
    });
  }

  /** Seed a blob directly (bypass HEAD/PUT flow). */
  seedBlob(groupId: string, hash: string, data: Uint8Array): void {
    this.blobs.set(hash, data);
    let refs = this.blobRefs.get(groupId);
    if (!refs) {
      refs = new Set();
      this.blobRefs.set(groupId, refs);
    }
    refs.add(hash);
  }

  /** Seed a remote change directly. */
  seedChange(groupId: string, change: Omit<ChangeEntry, 'seq'>): ChangeEntry {
    this.seqCounter += 1;
    const entry: ChangeEntry = { ...change, seq: this.seqCounter };
    const list = this.changes.get(groupId) ?? [];
    list.push(entry);
    this.changes.set(groupId, list);

    // Update files map
    const fileMap = this.files.get(groupId) ?? new Map();
    const key = pathKey(entry.path);
    fileMap.set(key, { path: entry.path, hash: entry.hash, seq: entry.seq });
    this.files.set(groupId, fileMap);

    return entry;
  }

  /** Get a token for a group (for creating a device directly in tests). */
  addDevice(
    groupId: string,
    opts: {
      userId: string;
      label?: string;
      role?: Role;
    },
  ): string {
    const token = `pch_fake_${newId()}`;
    const deviceId = newId();
    const device: DeviceRecord = {
      id: deviceId,
      userId: opts.userId,
      groupId,
      label: opts.label ?? 'device',
      token,
    };
    this.devices.set(token, device);
    const members = this.members.get(groupId) ?? new Map();
    members.set(opts.userId, { userId: opts.userId, role: opts.role ?? 'editor' });
    this.members.set(groupId, members);
    return token;
  }

  // ── Request dispatch ────────────────────────────────────────────────────────

  async request(req: HttpRequest): Promise<HttpResponse> {
    // Simulate latency
    if (this.latencyMs > 0 && this.clock.sleep) {
      await this.clock.sleep(this.latencyMs);
    }

    // Check abort signal
    if (req.signal?.aborted) {
      this.lastSignalWasAborted = true;
      throw new DOMException('Request aborted', 'AbortError');
    }

    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    // Record every request for test assertions
    this.requestLog.push({ method, url: req.url });

    // POST /api/join
    if (method === 'POST' && path === '/api/join') {
      return this.handleJoin(req);
    }

    // GET /api/g/:slug/changes
    const changesMatch = path.match(/^\/api\/g\/([^/]+)\/changes$/);
    if (method === 'GET' && changesMatch) {
      const slug = changesMatch[1];
      if (slug === undefined) return err(400, 'bad_request');
      return this.handleChanges(req, slug, url);
    }

    // POST /api/g/:slug/push
    const pushMatch = path.match(/^\/api\/g\/([^/]+)\/push$/);
    if (method === 'POST' && pushMatch) {
      const slug = pushMatch[1];
      if (slug === undefined) return err(400, 'bad_request');
      return this.handlePush(req, slug);
    }

    // GET /api/web/invites/:code/check (PARCHE-011)
    const checkInviteMatch = path.match(/^\/api\/web\/invites\/([^/]+)\/check$/);
    if (method === 'GET' && checkInviteMatch) {
      const code = decodeURIComponent(checkInviteMatch[1] ?? '');
      return this.handleCheckInvite(code);
    }

    // HEAD/GET/PUT /api/blob/:hash
    const blobMatch = path.match(/^\/api\/blob\/([a-f0-9]{64})$/);
    if (blobMatch) {
      const hash = blobMatch[1];
      if (hash === undefined) return err(400, 'bad_request');
      if (method === 'HEAD') return this.handleHeadBlob(req, hash);
      if (method === 'GET') return this.handleGetBlob(req, hash);
      if (method === 'PUT') return this.handlePutBlob(req, hash);
    }

    return err(404, 'not_found');
  }

  // ── Auth helper ─────────────────────────────────────────────────────────────

  private authenticate(req: HttpRequest): DeviceRecord | null {
    const auth = req.headers?.Authorization ?? req.headers?.authorization ?? '';
    const token = auth.match(/^Bearer (.+)$/)?.[1];
    if (!token) return null;
    return this.devices.get(token) ?? null;
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  // ── PARCHE-011: checkInvite handler ──────────────────────────────────────────

  private handleCheckInvite(code: string): HttpResponse {
    // Override knob: return fixed status/body or throw
    if (this.checkInviteOverride === 'throw') {
      throw new Error('Simulated network error from FakeParche.checkInvite');
    }
    if (this.checkInviteOverride !== null) {
      return json(this.checkInviteOverride.body, this.checkInviteOverride.status);
    }

    const invite = this.invites.get(code.toUpperCase());
    if (!invite) return json({ error: 'not_found' }, 404);

    const group = this.groups.get(invite.groupId);
    if (!group) return json({ error: 'not_found' }, 404);

    const isValid = invite.maxUses === null || invite.uses < invite.maxUses;
    if (!isValid) return json({ valid: false }, 200);

    return json({ valid: true, group: { name: group.name, slug: group.slug } }, 200);
  }

  private handleJoin(req: HttpRequest): HttpResponse {
    if (this.rateLimitJoin) return err(429, 'rate_limited');

    let body: unknown;
    try {
      body = JSON.parse(
        dec.decode(req.body instanceof Uint8Array ? req.body : enc.encode(String(req.body ?? ''))),
      );
    } catch {
      return err(400, 'bad_request');
    }

    const parsed = joinRequestSchema.safeParse(body);
    if (!parsed.success) return err(400, 'bad_request');

    // Capture last join request for test assertions
    this.lastJoinRequest = body as Record<string, unknown>;

    const { code, name, email, deviceLabel } = parsed.data;
    const invite = this.invites.get(code.toUpperCase());

    if (!invite) return err(404, 'not_found');
    if (invite.maxUses !== null && invite.uses >= invite.maxUses) return err(404, 'not_found');

    const group = this.groups.get(invite.groupId);
    if (!group) return err(404, 'not_found');

    // Look up or create user
    let user = this.usersByEmail.get(email);
    if (!user) {
      user = { id: newId(), name, email };
      this.users.set(user.id, user);
      this.usersByEmail.set(email, user);
    }

    // Check existing membership
    const groupMembers = this.members.get(group.id) ?? new Map();
    if (groupMembers.has(user.id)) {
      return err(409, 'already_member');
    }

    // Add member
    groupMembers.set(user.id, { userId: user.id, role: invite.role });
    this.members.set(group.id, groupMembers);

    // Create device + token
    const token = `pch_fake_${newId()}`;
    const device: DeviceRecord = {
      id: newId(),
      userId: user.id,
      groupId: group.id,
      label: deviceLabel ?? 'device',
      token,
    };
    this.devices.set(token, device);

    // Increment invite uses
    invite.uses += 1;

    const responseData: JoinResponse = {
      group: { id: group.id, slug: group.slug, name: group.name },
      role: invite.role,
      deviceToken: token,
      user: { id: user.id, name: user.name },
      device: { id: device.id, label: device.label },
    };

    return json(joinResponseSchema.parse(responseData));
  }

  private handleChanges(req: HttpRequest, slug: string, url: URL): HttpResponse {
    const device = this.authenticate(req);
    if (!device) return err(401, 'unauthorized');

    const group = [...this.groups.values()].find((g) => g.slug === slug);
    if (!group) return err(404, 'not_found');
    if (device.groupId !== group.id) return err(403, 'forbidden');

    const since = parseInt(url.searchParams.get('since') ?? '0', 10);
    const limit = Math.min(
      1000,
      Math.max(1, parseInt(url.searchParams.get('limit') ?? '500', 10)),
      this.pageLimit,
    );

    // Track page count for failChangesPage (global counter per group)
    const pageNum = (this.changesPageCount.get(group.id) ?? 0) + 1;
    this.changesPageCount.set(group.id, pageNum);

    if (this.failChangesPage !== null && pageNum >= this.failChangesPage) {
      return err(500, 'internal_server_error');
    }

    const allChanges = this.changes.get(group.id) ?? [];
    const filtered = allChanges.filter((c) => c.seq > since);
    const hasMore = filtered.length > limit;
    const page = filtered.slice(0, limit);
    const lastEntry = page[page.length - 1];
    const cursor = lastEntry !== undefined ? lastEntry.seq : since;

    const body: ChangesResponse = {
      protocol: PROTOCOL_VERSION,
      changes: page,
      cursor,
      hasMore,
    };

    return json(changesResponseSchema.parse(body));
  }

  private handlePush(req: HttpRequest, slug: string): HttpResponse {
    const device = this.authenticate(req);
    if (!device) return err(401, 'unauthorized');

    const group = [...this.groups.values()].find((g) => g.slug === slug);
    if (!group) return err(404, 'not_found');
    if (device.groupId !== group.id) return err(403, 'forbidden');

    let body: unknown;
    try {
      body = JSON.parse(
        dec.decode(req.body instanceof Uint8Array ? req.body : enc.encode(String(req.body ?? ''))),
      );
    } catch {
      return err(400, 'bad_request');
    }

    const parsed = pushRequestSchema.safeParse(body);
    if (!parsed.success) return err(400, 'bad_request');

    const { changes: pushChanges } = parsed.data;

    // Syncability check
    for (const { path } of pushChanges) {
      if (!isSyncable(path)) return err(400, 'unsyncable_path');
    }

    // Blob presence check (scoped to group)
    const groupRefs = this.blobRefs.get(group.id) ?? new Set();
    const wantedHashes = [
      ...new Set(
        pushChanges.flatMap(({ newHash }: PushChange) => (newHash !== null ? [newHash] : [])),
      ),
    ];

    // rejectPushBlobs knob (always rejects)
    const alwaysMissing = wantedHashes.filter((h) => this.rejectedPushBlobs.has(h));
    if (alwaysMissing.length > 0) {
      return json({ error: 'missing_blobs', hashes: alwaysMissing }, 422);
    }

    // rejectPushBlobsOnce knob (transient: rejects once, then clears)
    const onceMissing = wantedHashes.filter((h) => (this.rejectedPushBlobsOnce.get(h) ?? 0) > 0);
    if (onceMissing.length > 0) {
      for (const h of onceMissing) {
        const remaining = (this.rejectedPushBlobsOnce.get(h) ?? 1) - 1;
        if (remaining <= 0) {
          this.rejectedPushBlobsOnce.delete(h);
        } else {
          this.rejectedPushBlobsOnce.set(h, remaining);
        }
      }
      return json({ error: 'missing_blobs', hashes: onceMissing }, 422);
    }

    const missing = wantedHashes.filter((h) => !groupRefs.has(h));
    if (missing.length > 0) {
      return json({ error: 'missing_blobs', hashes: missing }, 422);
    }

    // Apply in order (simulate server transaction)
    const fileMap = this.files.get(group.id) ?? new Map();
    const results: Array<
      | { status: 'ok'; path: string; seq: number }
      | { status: 'conflict'; path: string; currentHash: string | null }
    > = [];
    const user = this.users.get(device.userId) ?? { id: device.userId, name: 'unknown', email: '' };
    const now = this.clock.now().toISOString();

    for (const { path, baseHash, newHash } of pushChanges) {
      // Case collision check (only for live writes)
      const key = pathKey(path);
      const existing = fileMap.get(key);
      if (newHash !== null && existing && existing.path !== path && existing.hash !== null) {
        return json({ error: 'case_collision', path, existing: existing.path }, 409);
      }

      const head = existing?.hash ?? null;

      // Gate: null→null on never-existing file → conflict (no row created)
      if (existing === undefined && baseHash === null && newHash === null) {
        results.push({ status: 'conflict', path, currentHash: null });
        continue;
      }

      // Idempotent: newHash already matches head
      if (existing !== undefined && newHash === head) {
        results.push({ status: 'ok', path, seq: existing.seq });
        continue;
      }

      // Conflict: baseHash doesn't match current head
      if (baseHash !== head) {
        results.push({ status: 'conflict', path, currentHash: head });
        continue;
      }

      // Advance: apply the change
      this.seqCounter += 1;
      const at = now;
      const changeEntry: ChangeEntry = {
        seq: this.seqCounter,
        path,
        hash: newHash,
        author: user.name,
        device: device.label,
        at,
      };
      results.push({ status: 'ok', path, seq: this.seqCounter });
      const changeList = this.changes.get(group.id) ?? [];
      changeList.push(changeEntry);
      this.changes.set(group.id, changeList);

      // Update file map
      fileMap.set(key, { path, hash: newHash, seq: this.seqCounter });
    }
    this.files.set(group.id, fileMap);

    return json(pushResponseSchema.parse({ results }));
  }

  private handleHeadBlob(req: HttpRequest, hash: string): HttpResponse {
    const device = this.authenticate(req);
    if (!device) return { status: 401, headers: {}, body: new Uint8Array(0) };

    const refs = this.blobRefs.get(device.groupId) ?? new Set();
    if (!refs.has(hash)) return { status: 404, headers: {}, body: new Uint8Array(0) };

    const data = this.blobs.get(hash);
    if (!data) return { status: 404, headers: {}, body: new Uint8Array(0) };

    return {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(data.byteLength),
      },
      body: new Uint8Array(0),
    };
  }

  private handleGetBlob(req: HttpRequest, hash: string): HttpResponse {
    const device = this.authenticate(req);
    if (!device) return err(401, 'unauthorized');

    const refs = this.blobRefs.get(device.groupId) ?? new Set();
    if (!refs.has(hash)) return err(404, 'not_found');

    const data = this.blobs.get(hash);
    if (!data) return err(404, 'not_found');

    // corruptBlob knob: return wrong bytes
    if (this.corruptedBlobs.has(hash)) {
      const corrupt = new Uint8Array(data.length);
      for (let i = 0; i < data.length; i++) corrupt[i] = (data[i] ?? 0) ^ 0xff;
      return {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body: corrupt,
      };
    }

    return {
      status: 200,
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(data.byteLength),
      },
      body: data,
    };
  }

  private handlePutBlob(req: HttpRequest, hash: string): HttpResponse {
    const device = this.authenticate(req);
    if (!device) return err(401, 'unauthorized');

    const data = req.body instanceof Uint8Array ? req.body : enc.encode(String(req.body ?? ''));
    const alreadyExists = this.blobs.has(hash);
    this.blobs.set(hash, data);

    let refs = this.blobRefs.get(device.groupId);
    if (!refs) {
      refs = new Set();
      this.blobRefs.set(device.groupId, refs);
    }
    refs.add(hash);

    const status = alreadyExists ? 200 : 201;
    return json({ hash, size: data.byteLength }, status);
  }
}
