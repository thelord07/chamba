/**
 * vault-sync/runner.ts — sync orchestration over ports.
 * Pure: no Node imports. All IO via ports (fs, http, hash, clock).
 *
 * Phases of syncOnce:
 *   1. scanLocal → planPush → push (in batches ≤500); on 422 PUT only missing blobs → retry
 *   2. Fetch all pages → planPull → execute actions → save state
 *   3. If conflicts: scanLocal (for copies) → push copies
 *
 * See PARCHE-004 plan for full spec.
 */

import type { ClockPort } from '../ports/clock.js';
import type { FilesystemPort } from '../ports/filesystem.js';
import type { HashPort } from '../ports/hash.js';
import type { HttpPort } from '../ports/http.js';
import { detectStyle, isInvalidPath } from '../util/local-path.js';
import { joinPath } from '../util/path.js';
import { addConflictFrontmatter, readConflictMeta } from './conflict.js';
import { CredentialsStore } from './credentials.js';
import { linkDirPlaceholderHint, linkHint } from './messages.js';
import {
  ParcheCaseCollisionError,
  ParcheClient,
  ParcheHttpError,
  ParcheMissingBlobsError,
} from './parche-client.js';
import { findCaseCollisions } from './path-key.js';
import type { PullAction, PushEntry, SyncState } from './plan.js';
import { applyPullPlan, applyPushResults, planPull, planPush } from './plan.js';
import type { ChangeEntry, JoinRequest } from './protocol.js';
import type { SyncStateFile } from './state-store.js';
import {
  clearPendingAdoption,
  mergeIntoStateFile,
  pendingJoinCodeHashOf,
  readState,
  resetVaultState,
  writeState,
} from './state-store.js';
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
  /**
   * CHAMBA-015 S10: OS platform string (injected so core stays pure and tests can
   * exercise Windows name validation on any host). Defaults to `'posix'` (no
   * Windows name checks). Pass `process.platform` (or `services.platform`) from
   * the adapter layer.
   */
  platform?: string;
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
  /**
   * PARCHE-010 O2: additive field with the same entries as `movedToTrash` but
   * enriched with the trash destination path. Kept alongside `movedToTrash`
   * to avoid breaking existing consumers.
   */
  movedToTrashEntries: Array<{ path: string; trashPath: string }>;
  errors: string[];
  /**
   * CHAMBA-015 S10 / D2.3: vault-relative paths skipped during pull because the
   * name is invalid on Windows. Only populated when `platform === 'win32'`.
   * Optional for backward-compatibility with code that constructs a partial summary.
   */
  skippedInvalidNames?: string[];
  /**
   * CHAMBA-015 D2.4: vault-relative paths pushed from a non-Windows machine
   * whose names are invalid on Windows. The push proceeded normally — this is a
   * warning to prompt the author to rename the file.
   * Optional for backward-compatibility with code that constructs a partial summary.
   */
  windowsIncompatibleNames?: string[];
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
 * exists on disk. Never recreated — the user must run the link command.
 */
export class VaultDirMissingError extends Error {
  override name = 'VaultDirMissingError';
  constructor(
    public readonly vaultDir: string,
    public readonly slug: string,
  ) {
    super(
      `La carpeta "${vaultDir}" del parche "${slug}" ya no existe. ` +
        `Usa \`${linkDirPlaceholderHint(slug)}\`.`,
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
        `Corre \`${linkHint(slug, vaultDir, { yes: true })}\`.`,
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

// ─── pushAll ─────────────────────────────────────────────────────────────────

/** Error for an unrecoverable 422: lists at most 5 short hashes. */
function missingBlobsError(hashes: string[]): Error {
  const shown = hashes.slice(0, 5).map((h) => h.slice(0, 8));
  const more = hashes.length > shown.length ? ` y ${hashes.length - shown.length} más` : '';
  return new Error(`no se pudo completar el push: faltan blobs ${shown.join(', ')}${more}`);
}

/**
 * Push all entries in batches of ≤batchSize using a push-first strategy.
 * Returns updated SyncState.
 *
 * Flow per batch:
 *   push → if 422 missing_blobs: PUT only the reported hashes (dedup, in reported
 *   order) → retry push. Repeat while the set of missing blobs reduces, up to
 *   MAX_422_ROUNDS rounds of 422 per batch.
 *
 * Safety (parche/src/routes/push.ts): 422 is returned before the transaction, so
 * nothing is written on 422. Push is idempotent: if the row already exists with
 * newHash===head, it returns ok with the existing seq (even for tombstones). If a
 * later batch fails, state is not written and the next sync re-pushes all batches —
 * idempotent by protocol (§3), so the re-push returns ok with the existing seq.
 *
 * Throws without writing state when:
 *  - A hash reported as missing has no local source.
 *  - The set of missing hashes does not reduce vs the previous round.
 *  - MAX_422_ROUNDS rounds of 422 are exhausted.
 */
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

  const MAX_422_ROUNDS = 3;
  let currentState = state;

  for (let i = 0; i < entries.length; i += batchSize) {
    checkAbort(signal);
    const batch = entries.slice(i, i + batchSize);

    let roundsDone = 0;
    let prevMissingSet: Set<string> | null = null;
    let batchResponse: Awaited<ReturnType<ParcheClient['push']>> | undefined;

    for (;;) {
      checkAbort(signal);
      let pushErr: unknown;
      try {
        batchResponse = await client.push(slug, batch, signal);
        break;
      } catch (err) {
        if (!(err instanceof ParcheMissingBlobsError)) throw err;
        pushErr = err;
      }

      const missingErr = pushErr as ParcheMissingBlobsError;

      // Dedup hashes in the order reported by the server
      const seen = new Set<string>();
      const missingHashes: string[] = [];
      for (const h of missingErr.hashes) {
        if (!seen.has(h)) {
          seen.add(h);
          missingHashes.push(h);
        }
      }
      const missingSet = new Set(missingHashes);

      // Any missing hash without a local source → cannot complete; don't write state
      const noSource = missingHashes.filter((h) => !blobSource.has(h));
      if (noSource.length > 0) throw missingBlobsError(noSource);

      // Set didn't reduce vs previous round (§4.0: by size; the 3-round cap bounds the rest)
      if (prevMissingSet !== null && missingSet.size >= prevMissingSet.size) {
        throw missingBlobsError(missingHashes);
      }

      // Rounds exhausted → don't write state
      if (roundsDone >= MAX_422_ROUNDS) throw missingBlobsError(missingHashes);

      prevMissingSet = missingSet;
      roundsDone++;

      // PUT only the reported missing blobs (checkAbort before each one).
      for (const h of missingHashes) {
        const src = blobSource.get(h);
        if (src === undefined) throw missingBlobsError([h]); // unreachable: checked above
        checkAbort(signal);
        const data = await fs.readBytes(src);
        checkAbort(signal);
        await client.putBlob(h, data, signal);
      }
    }

    // batchResponse is always assigned before break (loop invariant)
    if (batchResponse === undefined) throw new Error('unexpected: no push response for batch');
    currentState = applyPushResults(currentState, batch, batchResponse);
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
  style?: ReturnType<typeof detectStyle>,
): Promise<{
  conflicts: Array<{ path: string; copyPath: string }>;
  movedToTrash: string[];
  movedToTrashEntries: Array<{ path: string; trashPath: string }>;
  errors: string[];
  conflictBlobSource: Map<string, string>;
  skippedInvalidNames: string[];
}> {
  const { fs, hash } = deps;
  const conflicts: Array<{ path: string; copyPath: string }> = [];
  const movedToTrash: string[] = [];
  const movedToTrashEntries: Array<{ path: string; trashPath: string }> = [];
  const errors: string[] = [];
  const conflictBlobSource = new Map<string, string>();
  const skippedInvalidNames: string[] = [];
  const effectiveStyle = style ?? 'posix';

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
          movedToTrashEntries.push({ path: action.path, trashPath: trashRelPath });
        }
        break;
      }

      case 'write': {
        checkAbort(signal);
        // CHAMBA-015 S10: skip files with Windows-invalid names on win32
        if (isInvalidPath(action.path, effectiveStyle)) {
          skippedInvalidNames.push(action.path);
          break;
        }
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

        // CHAMBA-015 S10 R2 note 4: if path (or copyPath) is invalid on Windows,
        // skip the ENTIRE conflict (both steps). The local file is NOT touched.
        // We report the path in skippedInvalidNames and do NOT write anything.
        if (isInvalidPath(path, effectiveStyle) || isInvalidPath(action.copyPath, effectiveStyle)) {
          skippedInvalidNames.push(path);
          break;
        }

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
          movedToTrashEntries.push({ path, trashPath: trashRelPath });
        }
        break;
      }
    }
  }

  return {
    conflicts,
    movedToTrash,
    movedToTrashEntries,
    errors,
    conflictBlobSource,
    skippedInvalidNames,
  };
}

// ─── syncOnce ─────────────────────────────────────────────────────────────────

export async function syncOnce(deps: SyncDeps, opts: SyncOpts): Promise<SyncSummary> {
  const { fs, http, hash, clock } = deps;
  const { vaultDir, server, slug, token, localAuthor, batchSize = 500, signal, platform } = opts;
  const style = detectStyle(platform ?? 'posix');

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
  // CHAMBA-015 D2.4: warn when pushing a file whose name is invalid on Windows.
  // The push proceeds normally — this is informational only.
  const windowsIncompatibleNames: string[] = [];
  if (style !== 'win32') {
    for (const entry of pushEntries) {
      if (entry.newHash !== null && isInvalidPath(entry.path, 'win32')) {
        windowsIncompatibleNames.push(entry.path);
      }
    }
  }

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

  // Save state after phase 1 (preserves any existing skippedPaths from stateFile)
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

  // Execute actions in order (passes style so invalid Windows names are skipped)
  const {
    conflicts,
    movedToTrash,
    movedToTrashEntries,
    errors,
    conflictBlobSource,
    skippedInvalidNames,
  } = await executePullActions(
    client,
    deps,
    vaultDir,
    pullPlan.actions,
    localAuthor,
    signal,
    style,
  );

  const pulledCount = pullPlan.actions.filter(
    (a) => (a.type === 'write' || a.type === 'conflict') && !skippedInvalidNames.includes(a.path),
  ).length;

  // Update state with pull results
  let postPullState = applyPullPlan(syncState, pullPlan);

  // CHAMBA-015 S10: reconcile state for skipped invalid-name paths.
  // Rule: for skipped paths, revert files[path] to the pre-pull value so the
  // next sync does not see a "local file missing" → push tombstone.
  // Also update skippedPaths map with the latest remote hash.
  const newSkippedPaths: Record<string, string> = { ...(baseStateFile.skippedPaths ?? {}) };

  // Handle paths that were part of this pull plan (write/conflict/delete actions)
  for (const action of pullPlan.actions) {
    const path = 'path' in action ? action.path : undefined;
    if (!path) continue;

    if (action.type === 'delete') {
      // Tombstone: always drop from skippedPaths, regardless of local validity
      delete newSkippedPaths[path];
    } else if (skippedInvalidNames.includes(path)) {
      // Skipped write or conflict: track the remote hash and revert files[path]
      const remoteHash =
        action.type === 'write'
          ? action.hash
          : action.type === 'conflict'
            ? (action.remoteHash ?? null)
            : null;
      if (remoteHash !== null) {
        newSkippedPaths[path] = remoteHash;
      }
      // Revert files[path] to pre-pull value so next push doesn't see it as deleted
      const prePullEntry = syncState.files[path];
      const newFiles = { ...postPullState.files };
      if (prePullEntry !== undefined) {
        newFiles[path] = { syncedHash: prePullEntry.syncedHash };
      } else {
        delete newFiles[path];
      }
      postPullState = { ...postPullState, files: newFiles };
    } else {
      // Successfully processed: remove from skippedPaths if it was there
      delete newSkippedPaths[path];
    }
  }

  // CHAMBA-015 S10 rule (d): retry pre-existing skipped paths before writing state.
  // For each path still in skippedPaths that did NOT appear in this pull's actions,
  // attempt to re-download. This handles "blob gone" gracefully (drops + warns).
  const actionPaths = new Set(
    pullPlan.actions.filter((a) => 'path' in a).map((a) => (a as { path: string }).path),
  );

  // CHAMBA-015 S10 bug fix (rule b): a remote delete of a skipped path that was
  // never written locally produces NO planPull action (S=null, L=null, R=null →
  // noop). Reconcile against allChanges so tombstones and hash updates for such
  // paths are applied even when planPull emitted nothing for them.
  const latestChangeByPath = new Map<string, string | null>();
  for (const change of allChanges) {
    latestChangeByPath.set(change.path, change.hash);
  }
  for (const skippedPath of Object.keys(newSkippedPaths)) {
    if (actionPaths.has(skippedPath)) continue; // already handled by action loop above
    const latestHash = latestChangeByPath.get(skippedPath);
    if (latestHash === undefined) continue; // path had no change in this sync window
    if (latestHash === null) {
      // Tombstone: server deleted this path → stop tracking it
      delete newSkippedPaths[skippedPath];
    } else {
      // New remote hash: refresh so the retry loop uses the latest blob
      newSkippedPaths[skippedPath] = latestHash;
    }
  }

  for (const [skippedPath, remoteHash] of Object.entries(newSkippedPaths)) {
    if (actionPaths.has(skippedPath)) continue; // already handled above
    // Skip if still an invalid name (re-check — name might have changed... but in
    // practice the name is deterministic, so this is always true on win32)
    if (isInvalidPath(skippedPath, style)) continue;
    // Path became valid (or platform changed) — try to download and write it
    try {
      const data = await downloadBlob(client, hash, remoteHash, signal);
      const absPath = joinPath(vaultDir, skippedPath);
      const dir = absPath.slice(0, absPath.lastIndexOf('/'));
      await fs.mkdir(dir);
      await fs.writeBytes(absPath, data);
      const newFiles = { ...postPullState.files };
      newFiles[skippedPath] = { syncedHash: remoteHash };
      postPullState = { ...postPullState, files: newFiles };
      delete newSkippedPaths[skippedPath];
    } catch (err) {
      // Blob-gone: 404 from the server means the blob was deleted.
      // BlobHashMismatchError must NOT be treated as gone (it is a data error).
      if (
        err instanceof ParcheHttpError &&
        err.status === 404 &&
        !(err instanceof BlobHashMismatchError)
      ) {
        errors.push(
          `Archivo skipped "${skippedPath}" ya no está disponible en el servidor (blob eliminado). ` +
            `Se elimina de la lista de pendientes.`,
        );
        delete newSkippedPaths[skippedPath];
      }
      // Other errors (network, hash mismatch, etc.): keep in skippedPaths, retry next sync
    }
  }

  // Save state after phase 2 with the updated skippedPaths
  const now2 = clock.now().toISOString();
  await writeState(
    fs,
    vaultDir,
    mergeIntoStateFile(baseStateFile, postPullState, now2, newSkippedPaths),
  );

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

      // Save state after phase 3 — pass newSkippedPaths so phase-2 skipped entries
      // are not lost when conflicts cause a re-write of state here.
      const now3 = clock.now().toISOString();
      await writeState(
        fs,
        vaultDir,
        mergeIntoStateFile(baseStateFile, phase3State, now3, newSkippedPaths),
      );
    }
  }

  return {
    pushed: pushedCount,
    pulled: pulledCount,
    conflicts,
    movedToTrash,
    movedToTrashEntries,
    errors,
    skippedInvalidNames,
    windowsIncompatibleNames,
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
  /**
   * CHAMBA-015 S8: called when the Windows ACL hardening of credentials.json
   * fails (e.g. domain account whose name icacls cannot resolve). The token is
   * never included in the message. When absent, warnings are silently discarded.
   */
  onCredWarn?: (msg: string) => void;
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
  movedToTrashEntries: [],
  errors: [],
};

export async function joinOnce(deps: SyncDeps, opts: JoinOnceOpts): Promise<JoinOnceResult> {
  const { fs, http, hash, clock } = deps;
  const { server, homedir, joinRequest, signal, skipInitialSync, onCredWarn } = opts;

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
  // onCredWarn is forwarded so callers (CLI, tools) can surface Windows ACL warnings.
  const creds = new CredentialsStore(fs, homedir, onCredWarn);
  await creds.set(server, slug, {
    token,
    user: { id: joinRes.user.id, name: joinRes.user.name },
    device: { id: joinRes.device.id, label: joinRes.device.label },
    role: joinRes.role,
    ...(customDir ? { dir: customDir } : {}),
  });

  // Reset state (cursor=0, files={}, pendingAdoption=true) with the new groupId.
  // PARCHE-010 R15: compute and persist the pendingJoinCodeHash so resume paths
  // can verify the caller is using the same invite code without storing the code.
  const joinCodeHash = await pendingJoinCodeHashOf(hash, server, joinRequest.code);
  await resetVaultState(
    fs,
    vaultDir,
    { server, slug, groupId, pendingJoinCodeHash: joinCodeHash },
    clock,
  );

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
    await writeState(fs, vaultDir, clearPendingAdoption(stateFile));
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
