/**
 * vault-sync/runner.ts — sync orchestration over ports.
 * Pure: no Node imports. All IO via ports (fs, http, hash, clock).
 *
 * Phases of syncOnce:
 *   1. scanLocal → planPush → HEAD/PUT blobs → push (in batches ≤500)
 *   2. Fetch all pages → planPull → execute actions → save state
 *   3. If conflicts: scanLocal (for copies) → push copies
 *
 * See PARCHE-004 plan for full spec.
 */

import type { ClockPort } from '../ports/clock.js';
import type { FilesystemPort } from '../ports/filesystem.js';
import type { HashPort } from '../ports/hash.js';
import type { HttpPort } from '../ports/http.js';
import { joinPath } from '../util/path.js';
import { addConflictFrontmatter, readConflictMeta } from './conflict.js';
import { CredentialsStore } from './credentials.js';
import {
  ParcheCaseCollisionError,
  ParcheClient,
  ParcheMissingBlobsError,
} from './parche-client.js';
import { findCaseCollisions } from './path-key.js';
import type { PullAction, PushEntry, SyncState } from './plan.js';
import { applyPullPlan, applyPushResults, planPull, planPush } from './plan.js';
import type { ChangeEntry, JoinRequest } from './protocol.js';
import type { SyncStateFile } from './state-store.js';
import { mergeIntoStateFile, readState, resetVaultState, writeState } from './state-store.js';
import { isSyncable } from './sync-filter.js';
import { resolveVaultDir } from './vault-dir.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SyncDeps {
  fs: FilesystemPort;
  http: HttpPort;
  hash: HashPort;
  clock: ClockPort;
}

export interface SyncOpts {
  vaultDir: string;
  server: string;
  slug: string;
  token: string;
  localAuthor: string;
  device: string;
  batchSize?: number;
  signal?: AbortSignal;
}

export interface JoinOpts {
  vaultDir: string;
  server: string;
  homedir: string;
  joinRequest: JoinRequest;
  signal?: AbortSignal;
}

export interface SyncSummary {
  pushed: number;
  pulled: number;
  conflicts: Array<{ path: string; copyPath: string }>;
  movedToTrash: string[];
  errors: string[];
}

/** Local snapshot: path → sha256 hex */
export type LocalSnapshot = Record<string, string>;

export class CaseCollisionError extends Error {
  override name = 'CaseCollisionError';
  constructor(public readonly collisions: string[][]) {
    super(
      `Case collision detected — these paths conflict on case-insensitive filesystems:\n` +
        collisions.map((g) => `  ${g.join(', ')}`).join('\n'),
    );
  }
}

export class BlobHashMismatchError extends Error {
  override name = 'BlobHashMismatchError';
  constructor(
    public readonly path: string,
    public readonly expected: string,
    public readonly got: string,
  ) {
    super(`Hash mismatch for "${path}": expected ${expected}, got ${got}`);
  }
}

/**
 * PARCHE-009: thrown when the vault directory stored in the credential no longer
 * exists on disk. Never recreated — the user must run `chamba vault link <slug> --dir <ruta>`.
 */
export class VaultDirMissingError extends Error {
  override name = 'VaultDirMissingError';
  constructor(
    public readonly vaultDir: string,
    public readonly slug: string,
  ) {
    super(
      `La carpeta "${vaultDir}" del parche "${slug}" ya no existe. ` +
        `Usa \`chamba vault link ${slug} --dir <ruta>\`.`,
    );
  }
}

/**
 * PARCHE-009: thrown when a vault is in `pendingAdoption` state, meaning it has been
 * joined/linked but the adoption gate has not been confirmed yet.
 */
export class AdoptionPendingError extends Error {
  override name = 'AdoptionPendingError';
  constructor(
    public readonly vaultDir: string,
    public readonly slug: string,
  ) {
    super(
      `La ruta "${vaultDir}" está pendiente de confirmar. ` +
        `Corre \`chamba vault link ${slug} --dir "${vaultDir}" --yes\`.`,
    );
  }
}

// ─── scanLocal ────────────────────────────────────────────────────────────────

/**
 * Scan the vault directory, hash every syncable file, and return a snapshot.
 * Throws `CaseCollisionError` if any paths collide case-insensitively.
 */
export async function scanLocal(
  deps: Pick<SyncDeps, 'fs' | 'hash'>,
  vaultDir: string,
): Promise<{ snapshot: LocalSnapshot; blobSource: Map<string, string> }> {
  const { fs, hash } = deps;
  const snapshot: LocalSnapshot = {};
  const blobSource = new Map<string, string>(); // hash → vault-absolute path

  async function walk(dir: string, relDir: string): Promise<void> {
    let entries: Awaited<ReturnType<FilesystemPort['readDir']>>;
    try {
      entries = await fs.readDir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const absPath = joinPath(dir, entry.name);
      const relPath = relDir.length > 0 ? `${relDir}/${entry.name}` : entry.name;

      if (entry.isDirectory) {
        await walk(absPath, relPath);
      } else if (entry.isFile) {
        const normalizedRel = relPath.normalize('NFC');
        if (!isSyncable(normalizedRel)) continue;
        const bytes = await fs.readBytes(absPath);
        const h = await hash.sha256(bytes);
        snapshot[normalizedRel] = h;
        blobSource.set(h, absPath);
      }
    }
  }

  await walk(vaultDir, '');

  const collisions = findCaseCollisions(Object.keys(snapshot));
  if (collisions.length > 0) {
    throw new CaseCollisionError(collisions);
  }

  return { snapshot, blobSource };
}

// ─── checkAbort ───────────────────────────────────────────────────────────────

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Sync aborted', 'AbortError');
  }
}

// ─── nextTrashPath ────────────────────────────────────────────────────────────

/** Compute the next available path under `<vaultDir>/.trash/<relPath>`. */
async function nextTrashPath(
  fs: FilesystemPort,
  vaultDir: string,
  relPath: string,
): Promise<string> {
  const lastSlash = relPath.lastIndexOf('/');
  const dir = lastSlash >= 0 ? relPath.slice(0, lastSlash) : '';
  const name = lastSlash >= 0 ? relPath.slice(lastSlash + 1) : relPath;

  const dotIdx = name.lastIndexOf('.');
  const stem = dotIdx > 0 ? name.slice(0, dotIdx) : name;
  const ext = dotIdx > 0 ? name.slice(dotIdx) : '';

  const trashBase = '.trash';
  const trashDir = dir.length > 0 ? `${trashBase}/${dir}` : trashBase;

  const candidate = (n?: number): string => {
    const fname = n === undefined ? `${stem}${ext}` : `${stem} (${n})${ext}`;
    return `${trashDir}/${fname}`;
  };

  let n: number | undefined;
  let c = candidate(n);
  while (await fs.exists(joinPath(vaultDir, c))) {
    n = n === undefined ? 2 : n + 1;
    c = candidate(n);
  }
  return c;
}

// ─── uploadBlobs ─────────────────────────────────────────────────────────────

/**
 * For each unique newHash in entries: HEAD the blob; if 404, PUT it.
 * Returns nothing; throws on failure.
 */
async function uploadBlobs(
  client: ParcheClient,
  entries: PushEntry[],
  blobSource: Map<string, string>,
  fs: FilesystemPort,
  signal?: AbortSignal,
): Promise<void> {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.newHash === null) continue;
    if (seen.has(entry.newHash)) continue;
    seen.add(entry.newHash);

    checkAbort(signal);
    const exists = await client.headBlob(entry.newHash, signal);
    if (!exists) {
      const absPath = blobSource.get(entry.newHash);
      if (!absPath) {
        throw new Error(`No blob source for hash ${entry.newHash}`);
      }
      const data = await fs.readBytes(absPath);
      checkAbort(signal);
      await client.putBlob(entry.newHash, data, signal);
    }
  }
}

// ─── pushAll ─────────────────────────────────────────────────────────────────

/** Push all entries in batches of ≤batchSize. Returns updated SyncState. */
async function pushAll(
  client: ParcheClient,
  slug: string,
  state: SyncState,
  entries: PushEntry[],
  blobSource: Map<string, string>,
  fs: FilesystemPort,
  batchSize: number,
  signal?: AbortSignal,
): Promise<SyncState> {
  if (entries.length === 0) return state;

  // Upload all blobs first
  await uploadBlobs(client, entries, blobSource, fs, signal);

  let currentState = state;

  for (let i = 0; i < entries.length; i += batchSize) {
    checkAbort(signal);
    const batch = entries.slice(i, i + batchSize);

    let response: Awaited<ReturnType<ParcheClient['push']>>;
    try {
      response = await client.push(slug, batch, signal);
    } catch (err) {
      if (err instanceof ParcheMissingBlobsError) {
        // 422: upload the missing blobs and retry once
        const missingBlobSource = new Map<string, string>();
        for (const h of err.hashes) {
          const src = blobSource.get(h);
          if (!src) {
            throw new Error(`422 missing_blobs: no source for hash ${h} — cannot recover`);
          }
          missingBlobSource.set(h, src);
        }
        for (const [h, src] of missingBlobSource) {
          checkAbort(signal);
          const data = await fs.readBytes(src);
          await client.putBlob(h, data, signal);
        }
        // Retry once
        checkAbort(signal);
        try {
          response = await client.push(slug, batch, signal);
        } catch (retryErr) {
          if (retryErr instanceof ParcheMissingBlobsError) {
            throw new Error(`Push failed after retry: missing blobs ${retryErr.hashes.join(', ')}`);
          }
          throw retryErr;
        }
      } else {
        throw err;
      }
    }

    currentState = applyPushResults(currentState, batch, response);
  }

  return currentState;
}

// ─── downloadBlob ────────────────────────────────────────────────────────────

async function downloadBlob(
  client: ParcheClient,
  hash: HashPort,
  expectedHash: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const data = await client.getBlob(expectedHash, signal);
  const actualHash = await hash.sha256(data);
  if (actualHash !== expectedHash) {
    throw new BlobHashMismatchError('(download)', expectedHash, actualHash);
  }
  return data;
}

// ─── findExistingConflictCopy ─────────────────────────────────────────────────

/**
 * Gate decision 2 (dedupe): scan the vault dir for an existing conflict copy
 * of `path` whose content exactly matches `expectedBytes`.
 * Returns the relative path if found, otherwise null.
 */
async function findExistingConflictCopy(
  fs: FilesystemPort,
  vaultDir: string,
  path: string,
  author: string,
  expectedBytes: Uint8Array,
): Promise<string | null> {
  // The copy name pattern: `<stem> (conflicto <author>[ N]).<ext>`
  const lastSlash = path.lastIndexOf('/');
  const dir = lastSlash >= 0 ? path.slice(0, lastSlash) : '';
  const name = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dotIdx = name.lastIndexOf('.');
  const stem = dotIdx > 0 ? name.slice(0, dotIdx) : name;
  const ext = dotIdx > 0 ? name.slice(dotIdx) : '';

  const sanitized =
    author
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'anon';

  // Pattern: `<stem> (conflicto <sanitized>[ \\d+])<ext>`
  const prefix = `${stem} (conflicto ${sanitized}`;

  const absDir = dir.length > 0 ? joinPath(vaultDir, dir) : vaultDir;
  let entries: Awaited<ReturnType<FilesystemPort['readDir']>>;
  try {
    entries = await fs.readDir(absDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    if (!entry.isFile) continue;
    const nameLower = entry.name.toLowerCase();
    const prefixLower = prefix.toLowerCase();
    if (!nameLower.startsWith(prefixLower)) continue;
    // Check extension
    if (ext.length > 0 && !nameLower.endsWith(ext.toLowerCase())) continue;

    const candidateRel = dir.length > 0 ? `${dir}/${entry.name}` : entry.name;
    const candidateAbs = joinPath(vaultDir, candidateRel);

    // If it's a .md file, check conflict_of frontmatter
    if (ext.toLowerCase() === '.md') {
      let text: string;
      try {
        text = await fs.readFile(candidateAbs);
      } catch {
        continue;
      }
      const meta = readConflictMeta(text);
      if (meta?.conflictOf !== path) continue;

      // Check content match (compare after stripping the frontmatter we added)
      const bytes = new TextEncoder().encode(text);
      if (bytes.length === expectedBytes.length) {
        let match = true;
        for (let i = 0; i < bytes.length; i++) {
          if (bytes[i] !== expectedBytes[i]) {
            match = false;
            break;
          }
        }
        if (match) return candidateRel;
      }
    } else {
      // Binary: compare raw bytes
      let bytes: Uint8Array;
      try {
        bytes = await fs.readBytes(candidateAbs);
      } catch {
        continue;
      }
      if (bytes.length === expectedBytes.length) {
        let match = true;
        for (let i = 0; i < bytes.length; i++) {
          if (bytes[i] !== expectedBytes[i]) {
            match = false;
            break;
          }
        }
        if (match) return candidateRel;
      }
    }
  }
  return null;
}

// ─── writeConflictCopy ────────────────────────────────────────────────────────

/**
 * Write the conflict copy. Returns `{copyPath, bytes}` where `bytes` is what
 * was written (including frontmatter for .md). Deduplication (gate decision 2):
 * if an identical copy already exists, returns its path without writing again.
 */
async function writeConflictCopy(
  fs: FilesystemPort,
  vaultDir: string,
  action: Extract<PullAction, { type: 'conflict' }>,
  localAuthor: string,
  localBytes: Uint8Array,
): Promise<{ copyPath: string; bytes: Uint8Array }> {
  const { path, copyPath, base } = action;
  const isMarkdown = path.toLowerCase().endsWith('.md');

  let copyBytes: Uint8Array;
  if (isMarkdown) {
    const localText = new TextDecoder().decode(localBytes);
    const withFm = addConflictFrontmatter(localText, { conflictOf: path, conflictBase: base });
    copyBytes = new TextEncoder().encode(withFm);
  } else {
    copyBytes = localBytes;
  }

  // Dedupe: look for an existing identical copy
  const existing = await findExistingConflictCopy(fs, vaultDir, path, localAuthor, copyBytes);
  if (existing !== null) {
    return { copyPath: existing, bytes: copyBytes };
  }

  // Write the copy
  const dir = copyPath.includes('/') ? copyPath.slice(0, copyPath.lastIndexOf('/')) : '';
  if (dir.length > 0) {
    await fs.mkdir(joinPath(vaultDir, dir));
  }
  await fs.writeBytes(joinPath(vaultDir, copyPath), copyBytes);
  return { copyPath, bytes: copyBytes };
}

// ─── executePullActions ───────────────────────────────────────────────────────

async function executePullActions(
  client: ParcheClient,
  deps: SyncDeps,
  vaultDir: string,
  actions: PullAction[],
  localAuthor: string,
  signal?: AbortSignal,
): Promise<{
  conflicts: Array<{ path: string; copyPath: string }>;
  movedToTrash: string[];
  errors: string[];
  conflictBlobSource: Map<string, string>;
}> {
  const { fs, hash } = deps;
  const conflicts: Array<{ path: string; copyPath: string }> = [];
  const movedToTrash: string[] = [];
  const errors: string[] = [];
  const conflictBlobSource = new Map<string, string>();

  for (const action of actions) {
    checkAbort(signal);

    switch (action.type) {
      case 'noop':
        break;

      case 'delete': {
        const absPath = joinPath(vaultDir, action.path);
        const exists = await fs.exists(absPath);
        if (exists) {
          const trashRelPath = await nextTrashPath(fs, vaultDir, action.path);
          const trashAbsPath = joinPath(vaultDir, trashRelPath);
          const trashParentDir = trashAbsPath.slice(0, trashAbsPath.lastIndexOf('/'));
          await fs.mkdir(trashParentDir);
          await fs.rename(absPath, trashAbsPath);
          movedToTrash.push(action.path);
        }
        break;
      }

      case 'write': {
        checkAbort(signal);
        let data: Uint8Array;
        try {
          data = await downloadBlob(client, hash, action.hash, signal);
        } catch (err) {
          errors.push(
            `Failed to download blob for "${action.path}": ${err instanceof Error ? err.message : String(err)}`,
          );
          throw err; // propagate to abort the phase
        }
        const absPath = joinPath(vaultDir, action.path);
        const dir = absPath.slice(0, absPath.lastIndexOf('/'));
        await fs.mkdir(dir);
        await fs.writeBytes(absPath, data);
        break;
      }

      case 'conflict': {
        const { path, remoteHash, localHash } = action;
        const localAbsPath = joinPath(vaultDir, path);

        // 1. Read local bytes
        let localBytes: Uint8Array;
        try {
          localBytes = await fs.readBytes(localAbsPath);
        } catch {
          // If local file doesn't exist (unlikely), use empty bytes
          localBytes = new Uint8Array(0);
        }

        // Verify the local hash matches what planPull expected
        const actualLocalHash = await hash.sha256(localBytes);
        if (actualLocalHash !== localHash) {
          // Use actual bytes as the copy content
          // (file may have changed since scan — use current)
        }

        // 2. Write conflict copy (with dedupe)
        const { copyPath: finalCopyPath, bytes: copyBytes } = await writeConflictCopy(
          fs,
          vaultDir,
          action,
          localAuthor,
          localBytes,
        );
        conflicts.push({ path, copyPath: finalCopyPath });

        // Track for phase-3 push
        const copyHash = await hash.sha256(copyBytes);
        conflictBlobSource.set(copyHash, joinPath(vaultDir, finalCopyPath));

        // 3a. If remoteHash !== null → download and overwrite path
        if (remoteHash !== null) {
          let remoteData: Uint8Array;
          try {
            remoteData = await downloadBlob(client, hash, remoteHash, signal);
          } catch (err) {
            errors.push(
              `Failed to download remote blob for conflict "${path}": ${err instanceof Error ? err.message : String(err)}`,
            );
            throw err;
          }
          const dir = localAbsPath.slice(0, localAbsPath.lastIndexOf('/'));
          await fs.mkdir(dir);
          await fs.writeBytes(localAbsPath, remoteData);
        } else {
          // 3b. remoteHash === null → move local to trash (tombstone wins at path)
          const trashRelPath = await nextTrashPath(fs, vaultDir, path);
          const trashAbsPath = joinPath(vaultDir, trashRelPath);
          const trashParentDir = trashAbsPath.slice(0, trashAbsPath.lastIndexOf('/'));
          await fs.mkdir(trashParentDir);
          // Copy is already written above; move the original
          await fs.rename(localAbsPath, trashAbsPath);
          movedToTrash.push(path);
        }
        break;
      }
    }
  }

  return { conflicts, movedToTrash, errors, conflictBlobSource };
}

// ─── syncOnce ─────────────────────────────────────────────────────────────────

export async function syncOnce(deps: SyncDeps, opts: SyncOpts): Promise<SyncSummary> {
  const { fs, http, hash, clock } = deps;
  const { vaultDir, server, slug, token, localAuthor, batchSize = 500, signal } = opts;

  const client = new ParcheClient(http, server, token);

  // PARCHE-009: check vault dir exists before reading state. state.json lives
  // inside the dir, so if the dir is gone readState returns null and the sync
  // would silently proceed (or try to recreate it). joinOnce always creates the
  // dir before calling syncOnce, so this check is safe on first join too.
  const vaultExists = await fs.exists(vaultDir);
  if (!vaultExists) {
    throw new VaultDirMissingError(vaultDir, slug);
  }

  const stateFile = await readState(fs, vaultDir);

  // PARCHE-009: block sync if pendingAdoption
  if (stateFile?.pendingAdoption === true) {
    throw new AdoptionPendingError(vaultDir, slug);
  }
  let syncState: SyncState = stateFile
    ? { cursor: stateFile.cursor, files: stateFile.files }
    : { cursor: 0, files: {} };

  // ── Phase 1: Push ──────────────────────────────────────────────────────────
  checkAbort(signal);

  const { snapshot: localSnapshot, blobSource } = await scanLocal({ fs, hash }, vaultDir);
  const pushEntries = planPush(syncState, localSnapshot);

  let pushedCount = 0;

  if (pushEntries.length > 0) {
    syncState = await pushAll(
      client,
      slug,
      syncState,
      pushEntries,
      blobSource,
      fs,
      batchSize,
      signal,
    );
    pushedCount = pushEntries.filter((e) => e.newHash !== null).length;
  }

  // Save state after phase 1
  const now1 = clock.now().toISOString();
  const baseStateFile: SyncStateFile = stateFile ?? {
    server,
    slug,
    cursor: syncState.cursor,
    files: syncState.files,
  };
  await writeState(fs, vaultDir, mergeIntoStateFile(baseStateFile, syncState, now1));

  // ── Phase 2: Pull ──────────────────────────────────────────────────────────
  checkAbort(signal);

  // Fetch ALL pages first (before touching disk)
  const allChanges: ChangeEntry[] = [];
  let cursor = syncState.cursor;
  while (true) {
    checkAbort(signal);
    const page = await client.getChanges(slug, cursor, signal);
    // Guard: if the server says there are more pages but the cursor did not advance,
    // we would loop forever. Throw without writing anything.
    if (page.hasMore && page.cursor <= cursor) {
      throw new Error(
        `Sync protocol error: server returned hasMore=true but cursor did not advance ` +
          `(was ${cursor}, still ${page.cursor}). Aborting to avoid an infinite loop.`,
      );
    }
    allChanges.push(...page.changes);
    cursor = page.cursor;
    if (!page.hasMore) break;
  }

  // Single planPull over all changes
  const pullPlan = planPull(syncState, localSnapshot, allChanges, { localAuthor });

  // Execute actions in order
  const { conflicts, movedToTrash, errors, conflictBlobSource } = await executePullActions(
    client,
    deps,
    vaultDir,
    pullPlan.actions,
    localAuthor,
    signal,
  );

  const pulledCount = pullPlan.actions.filter(
    (a) => a.type === 'write' || a.type === 'conflict',
  ).length;

  // Update state with pull results
  const postPullState = applyPullPlan(syncState, pullPlan);

  // Save state after phase 2
  const now2 = clock.now().toISOString();
  await writeState(fs, vaultDir, mergeIntoStateFile(baseStateFile, postPullState, now2));

  // ── Phase 3: Push conflict copies ─────────────────────────────────────────
  if (conflicts.length > 0) {
    checkAbort(signal);

    // Re-scan to pick up the new copy files
    const { snapshot: localSnapshot2, blobSource: blobSource2 } = await scanLocal(
      { fs, hash },
      vaultDir,
    );
    // Merge conflict blob sources into blobSource2
    for (const [h, absPath] of conflictBlobSource) {
      blobSource2.set(h, absPath);
    }

    const pushEntries2 = planPush(postPullState, localSnapshot2);
    if (pushEntries2.length > 0) {
      let phase3State = postPullState;
      try {
        phase3State = await pushAll(
          client,
          slug,
          postPullState,
          pushEntries2,
          blobSource2,
          fs,
          batchSize,
          signal,
        );
      } catch (err) {
        if (err instanceof ParcheCaseCollisionError) {
          errors.push(
            `Case collision during conflict copy push: path "${err.path}" conflicts with "${err.existing}". ` +
              `Rename the copy manually to resolve.`,
          );
        } else {
          throw err;
        }
      }

      // Save state after phase 3
      const now3 = clock.now().toISOString();
      await writeState(fs, vaultDir, mergeIntoStateFile(baseStateFile, phase3State, now3));
    }
  }

  return {
    pushed: pushedCount,
    pulled: pulledCount,
    conflicts,
    movedToTrash,
    errors,
  };
}

// ─── joinOnce ─────────────────────────────────────────────────────────────────

export interface JoinOnceOpts {
  /**
   * Custom vault directory (absolute canonical path already validated by `prepareVaultDir`).
   * When empty or absent, the default location (resolveVaultDir) is used.
   */
  vaultDir?: string;
  server: string;
  homedir: string;
  joinRequest: JoinRequest;
  localAuthor?: string;
  signal?: AbortSignal;
  /**
   * PARCHE-009: when true, skip the initial syncOnce after join. The caller is
   * responsible for running syncOnce after gate confirmation. Implies
   * `pendingAdoption: true` in the written state.
   */
  skipInitialSync?: boolean;
}

export interface JoinOnceResult {
  slug: string;
  vaultDir: string;
  summary: SyncSummary;
}

/** Zero-count summary used when skipInitialSync is true. */
const ZERO_SUMMARY: SyncSummary = {
  pushed: 0,
  pulled: 0,
  conflicts: [],
  movedToTrash: [],
  errors: [],
};

export async function joinOnce(deps: SyncDeps, opts: JoinOnceOpts): Promise<JoinOnceResult> {
  const { fs, http, clock } = deps;
  const { server, homedir, joinRequest, signal, skipInitialSync } = opts;

  const client = new ParcheClient(http, server, '');

  // POST /api/join (token is not needed here, the join endpoint is unauthenticated)
  const joinRes = await client.join(joinRequest, signal);

  const { slug, id: groupId } = joinRes.group;
  const token = joinRes.deviceToken;

  // Compute vault directory: use custom dir or the default location (resolveVaultDir).
  // resolveVaultDir is the ONLY place the default path is constructed.
  const customDir = opts.vaultDir || undefined;
  const vaultDir = customDir ?? resolveVaultDir({}, homedir, slug);

  // Create vault directory and minimal .obsidian/
  await fs.mkdir(joinPath(vaultDir, '.obsidian'));

  // Save credentials (mode 0600, outside vault). Store dir only if custom.
  const creds = new CredentialsStore(fs, homedir);
  await creds.set(server, slug, {
    token,
    user: { id: joinRes.user.id, name: joinRes.user.name },
    device: { id: joinRes.device.id, label: joinRes.device.label },
    role: joinRes.role,
    ...(customDir ? { dir: customDir } : {}),
  });

  // Reset state (cursor=0, files={}, pendingAdoption=true) with the new groupId
  await resetVaultState(fs, vaultDir, { server, slug, groupId }, clock);

  if (skipInitialSync) {
    // Caller will handle the gate and then call syncOnce explicitly.
    // pendingAdoption remains true until the caller clears it.
    return { slug, vaultDir, summary: ZERO_SUMMARY };
  }

  // When skipInitialSync is false, clear pendingAdoption before syncing —
  // the caller has chosen to proceed without the gate (e.g. direct API use,
  // or the vault is empty so the gate passed automatically).
  const stateFile = await readState(fs, vaultDir);
  if (stateFile?.pendingAdoption === true) {
    const cleared = { ...stateFile };
    delete cleared.pendingAdoption;
    await writeState(fs, vaultDir, cleared);
  }

  // First sync
  const summary = await syncOnce(deps, {
    vaultDir,
    server,
    slug,
    token,
    localAuthor: joinRes.user.name,
    device: joinRes.device.label,
    signal,
  });

  return { slug, vaultDir, summary };
}
