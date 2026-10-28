/**
 * vault-sync/plan.ts — pure sync planner (planPush, planPull, applyPushResults).
 * No Node APIs, no LLM. Hashes are pre-computed strings.
 */

import { conflictCopyPath } from './conflict.js';
import type { ChangeEntry } from './protocol.js';

// ─── Domain types ─────────────────────────────────────────────────────────────

export interface SyncState {
  cursor: number;
  files: Record<string, { syncedHash: string | null }>;
}

/** Only syncable files; keys are NFC-normalized vault paths. */
export type LocalSnapshot = Record<string, string>;

export type PullAction =
  | { type: 'write'; path: string; hash: string }
  | { type: 'delete'; path: string }
  | {
      type: 'conflict';
      path: string;
      remoteHash: string | null;
      localHash: string;
      copyPath: string;
      base: string | null;
    }
  | { type: 'noop'; path: string };

export interface PullPlan {
  actions: PullAction[];
  cursor: number;
}

export interface PushEntry {
  path: string;
  baseHash: string | null;
  newHash: string | null;
}

// ─── planPush ─────────────────────────────────────────────────────────────────

/**
 * Compute the list of changes to push to the server.
 * - New local files → baseHash: null
 * - Modified files → baseHash: syncedHash
 * - Locally deleted files (syncedHash !== null) → newHash: null
 * - Unchanged and known-tombstone files → skipped
 * Returns sorted by path.
 */
export function planPush(state: SyncState, local: LocalSnapshot): PushEntry[] {
  const out: PushEntry[] = [];
  const allPaths = new Set([...Object.keys(state.files), ...Object.keys(local)]);

  for (const path of allPaths) {
    const fileState = state.files[path];
    const syncedHash = fileState?.syncedHash ?? null;
    const localHash = local[path] ?? null;

    if (localHash !== null) {
      // File exists locally
      if (localHash !== syncedHash) {
        // New or modified
        out.push({ path, baseHash: syncedHash, newHash: localHash });
      }
      // else: unchanged — skip
    } else {
      // File absent locally
      if (syncedHash !== null) {
        // Was synced, now deleted
        out.push({ path, baseHash: syncedHash, newHash: null });
      }
      // else: known tombstone (syncedHash === null) — skip
    }
  }

  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ─── planPull ─────────────────────────────────────────────────────────────────

export interface PlanPullOptions {
  localAuthor: string;
}

/**
 * Compute what to do with remote changes.
 *
 * Rules (evaluated top-down per remote path after null-normalizing S, L, R):
 *   S = state.files[path]?.syncedHash ?? null
 *   L = local[path] ?? null
 *   R = collapsed remote hash (null = tombstone)
 *
 * 1. R === L → noop
 * 2. L === S, R !== null → write
 * 3. L === S, R === null → delete
 * 4. L === null (L ≠ S), R !== null → write (content wins over local delete)
 * 5. L !== null, R !== null, R !== L → conflict
 * 6. L !== null, R === null → conflict (local preserved; tombstone wins at path)
 *
 * `existing` for copyPath is seeded from:
 *   local keys ∪ all remote paths (incl. tombstones) ∪ state.files paths with
 *   syncedHash !== null ∪ copyPaths already assigned.
 *
 * cursor = max(state.cursor, max seq of remote entries).
 *
 * NOTE: push before pull to avoid rule #4 resurrecting a local delete.
 */
export function planPull(
  state: SyncState,
  local: LocalSnapshot,
  remote: ChangeEntry[],
  opts: PlanPullOptions,
): PullPlan {
  // Collapse to max-seq entry per path
  const collapsed = new Map<string, { hash: string | null; seq: number }>();
  for (const entry of remote) {
    const current = collapsed.get(entry.path);
    if (current === undefined || entry.seq > current.seq) {
      collapsed.set(entry.path, { hash: entry.hash, seq: entry.seq });
    }
  }

  // Compute new cursor
  let maxSeq = state.cursor;
  for (const { seq } of collapsed.values()) {
    if (seq > maxSeq) maxSeq = seq;
  }

  // Seed existing set for copyPath collision avoidance (B2)
  const existing = new Set<string>();
  for (const k of Object.keys(local)) existing.add(k);
  for (const [p] of collapsed) existing.add(p);
  for (const [p, f] of Object.entries(state.files)) {
    if (f.syncedHash !== null) existing.add(p);
  }

  const actions: PullAction[] = [];

  for (const [path, remote_] of collapsed) {
    const S = state.files[path]?.syncedHash ?? null;
    const L = local[path] ?? null;
    const R = remote_.hash;

    // Rule 1: R === L → noop
    if (R === L) {
      actions.push({ type: 'noop', path });
      continue;
    }

    // Rule 2 & 3: local unchanged (L === S)
    if (L === S) {
      if (R !== null) {
        actions.push({ type: 'write', path, hash: R });
      } else {
        actions.push({ type: 'delete', path });
      }
      continue;
    }

    // L !== S (local changed)

    // Rule 4: L === null (locally deleted), R !== null → write (R already ≠ L)
    if (L === null) {
      // R must be non-null because rule 1 already handled R === L === null
      actions.push({ type: 'write', path, hash: R as string });
      continue;
    }

    // L !== null
    const base = S; // common ancestor = last synced hash (D1/B1)
    const copyPath = conflictCopyPath(path, opts.localAuthor, existing);
    existing.add(copyPath);

    // Rule 5: both changed differently
    if (R !== null) {
      actions.push({ type: 'conflict', path, remoteHash: R, localHash: L, copyPath, base });
      continue;
    }

    // Rule 6: L !== null, R === null
    actions.push({ type: 'conflict', path, remoteHash: null, localHash: L, copyPath, base });
  }

  return { actions, cursor: maxSeq };
}

// ─── applyPushResults ─────────────────────────────────────────────────────────

/**
 * Derive a new SyncState after receiving push results.
 * - ok → advance syncedHash to newHash (null = tombstone kept)
 * - conflict → unchanged
 * - missing result → unchanged
 * - ok result for a path that was not in the request → ignored
 * Cursor is unchanged. Input is not mutated.
 */
export function applyPushResults(
  state: SyncState,
  request: PushEntry[],
  response: { results: Array<{ status: 'ok' | 'conflict'; path: string }> },
): SyncState {
  // Build a lookup of ok results by path
  const okPaths = new Set<string>();
  for (const r of response.results) {
    if (r.status === 'ok') okPaths.add(r.path);
  }

  // Build lookup of newHash by path from request
  const newHashByPath = new Map<string, string | null>();
  for (const req of request) {
    newHashByPath.set(req.path, req.newHash);
  }

  const newFiles: Record<string, { syncedHash: string | null }> = {};
  // Copy existing state
  for (const [p, f] of Object.entries(state.files)) {
    newFiles[p] = { syncedHash: f.syncedHash };
  }
  // Apply ok results
  for (const path of okPaths) {
    // Only paths we actually pushed can advance; a stray ok must not invent state.
    if (!newHashByPath.has(path)) continue;
    // newHash null → tombstone kept as { syncedHash: null }
    newFiles[path] = { syncedHash: newHashByPath.get(path) ?? null };
  }

  return { cursor: state.cursor, files: newFiles };
}
