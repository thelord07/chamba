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

import { isChambaGenerated, isDerivedPathPattern } from '../obsidian/knowledge/derived-path.js';
import type { ClockPort } from '../ports/clock.js';
import type { FilesystemPort } from '../ports/filesystem.js';
import type { HashPort } from '../ports/hash.js';
import type { HttpPort } from '../ports/http.js';
import { readSecretAllowlist } from '../secrets/allowlist.js';
import type { Finding } from '../secrets/scanner.js';
import { scanText, shouldScanContent } from '../secrets/scanner.js';
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
  ParcheSecretDetectedError,
} from './parche-client.js';
import { findCaseCollisions } from './path-key.js';
import type { PullAction, PushEntry, SyncState } from './plan.js';
import { applyPullPlan, applyPushResults, planPull, planPush } from './plan.js';
import type { ChangeEntry, JoinRequest } from './protocol.js';
import type { PrecomputedFileFindings, ServerBlockedBlob } from './secret-gate.js';
import {
  allowDigestOf,
  computeBlockedSecretMap,
  computeServerBlockedMap,
  screenPushEntries,
} from './secret-gate.js';
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
  /**
   * CHAMBA-016: true when the pull applied changes to any `.md` or `.base`
   * file (including derived files and vocabulary), or when a derived conflict
   * was silently resolved by accepting the remote version. Callers should run
   * VaultReindexer.reindex() after a sync that sets this flag.
   */
  needsReindex?: boolean;
  /**
   * CHAMBA-016: vault-relative paths of derived files whose conflict was
   * resolved silently by accepting the remote version (no copy written).
   * Order is stable (path-alphabetical, same as action processing order).
   */
  derivedConflictsResolved?: string[];
  /**
   * CHAMBA-021 S6: findings for files excluded from this sync's push because
   * the secret scanner found an un-allowlisted secret (phases 1 and 3 combined).
   * Optional for backward-compatibility with code that constructs a partial summary.
   */
  blockedBySecret?: Finding[];
  /**
   * CHAMBA-023 S4: paths excluded from this sync's push because the SERVER
   * rejected their blob with `422 secret_detected` (phases 1 and 3
   * combined, deduplicated by path) — distinct from `blockedBySecret`
   * above, which is the LOCAL gate's own un-allowlisted findings. No
   * `hash` here (unlike the state map) — callers of the summary only need
   * path + kinds to report it. The sync still finishes OK: this never adds
   * to `errors`.
   */
  blockedBySecretServer?: Array<{ path: string; kinds: string[] }>;
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
 *
 * CHAMBA-023 D-Q3 (owner decision §9): when `knownHashes` is given (the
 * previous `syncedHash` per path, from `SyncState.files`), this ALSO scans
 * for secrets right here, on the SAME bytes it just read to compute the
 * hash — no extra read, no buffer retained past this one iteration. A path
 * is only scanned when its hash differs from `knownHashes[path]` (new or
 * changed content; unknown paths count as changed) — unchanged files are
 * never rescanned. The result, `findingsByPath`, is handed to
 * `screenPushEntries` (secret-gate.ts), which uses it when the hash still
 * matches and falls back to reading the file itself otherwise (e.g. a
 * phase-3 conflict copy this walk didn't know about yet).
 */
export async function scanLocal(
  deps: Pick<SyncDeps, 'fs' | 'hash'>,
  vaultDir: string,
  knownHashes?: Record<string, string | null>,
): Promise<{
  snapshot: LocalSnapshot;
  blobSource: Map<string, string>;
  findingsByPath: Map<string, PrecomputedFileFindings>;
}> {
  const { fs, hash } = deps;
  const snapshot: LocalSnapshot = {};
  const blobSource = new Map<string, string>(); // hash → vault-absolute path
  const findingsByPath = new Map<string, PrecomputedFileFindings>();

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

        if (knownHashes !== undefined && knownHashes[normalizedRel] !== h) {
          const text = shouldScanContent(bytes, normalizedRel);
          if (text !== null) {
            const findings = await scanText({ hash }, text, normalizedRel);
            findingsByPath.set(normalizedRel, { hash: h, findings, scanned: true });
          } else {
            findingsByPath.set(normalizedRel, { hash: h, findings: [], scanned: false });
          }
        }
      }
    }
  }

  await walk(vaultDir, '');

  const collisions = findCaseCollisions(Object.keys(snapshot));
  if (collisions.length > 0) {
    throw new CaseCollisionError(collisions);
  }

  return { snapshot, blobSource, findingsByPath };
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
 * Returns the updated SyncState plus every blob the SERVER rejected as a
 * possible secret this call (CHAMBA-023 S4).
 *
 * Flow per batch:
 *   push → if 422 missing_blobs: PUT only the reported hashes (dedup, in reported
 *   order) → retry push. Repeat until every missing hash this round is already
 *   FULLY handled — rejected as a secret (1 attempt, never retried), or PUT
 *   successfully and then re-reported missing again (2 attempts max, review
 *   item 5) — "progress by containment" (review ronda 2, N1) — up to
 *   MAX_422_ROUNDS rounds per batch regardless of whether progress is still
 *   being made (e.g. 4+ distinct hashes each reported missing one at a time,
 *   never repeating, still stops at round 3 — the cap is a hard ceiling on
 *   round-trips, not just a stall detector).
 *
 * Safety (parche/src/routes/push.ts): 422 is returned before the transaction, so
 * nothing is written on 422. Push is idempotent: if the row already exists with
 * newHash===head, it returns ok with the existing seq (even for tombstones). If a
 * later batch fails, state is not written and the next sync re-pushes all batches —
 * idempotent by protocol (§3), so the re-push returns ok with the existing seq.
 *
 * CHAMBA-023 S4 (secret rejection):
 *  - `allowFingerprintsByHash` is forwarded to every `putBlob` call so the
 *    server can skip findings already exempted locally for that content.
 *  - `rejectedHashes` is a `hash → kinds` map SHARED across every batch AND
 *    across phase 1 and phase 3 (the caller owns it): once a hash is
 *    rejected here, it is never PUT again this sync, in any batch, in any
 *    phase — every entry (any path) carrying that hash is excluded from its
 *    batch's push request and reported in the returned `serverBlocked`
 *    list instead.
 *  - A rejected hash's entries are removed from the CURRENT batch too
 *    (mid-retry-loop) so the retried `push()` never asks the server about
 *    it again.
 *  - B3 (review ronda 1): if excluding rejected entries leaves a batch
 *    empty, `push()`/`applyPushResults` are skipped entirely for that
 *    batch slice (never send an empty `changes` array — `pushRequestSchema`
 *    requires ≥1) and the loop moves on to the next batch.
 *
 * Throws without writing state when:
 *  - A hash reported as missing has no local source.
 *  - Every hash the server reports missing this round was already handled
 *    (PUT ok or rejected) in a prior round — no real progress.
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
  allowFingerprintsByHash: Map<string, string[]>,
  rejectedHashes: Map<string, string[]>,
  signal?: AbortSignal,
): Promise<{ state: SyncState; serverBlocked: ServerBlockedBlob[] }> {
  const serverBlocked: ServerBlockedBlob[] = [];
  if (entries.length === 0) return { state, serverBlocked };

  const MAX_422_ROUNDS = 3;
  let currentState = state;

  for (let i = 0; i < entries.length; i += batchSize) {
    checkAbort(signal);

    // Never re-send bytes already rejected earlier THIS SYNC (any batch, any
    // phase) — report them again (one entry per path sharing the hash) and
    // drop them from this batch before even attempting a push.
    let batch: PushEntry[] = [];
    for (const e of entries.slice(i, i + batchSize)) {
      const kinds = e.newHash !== null ? rejectedHashes.get(e.newHash) : undefined;
      if (e.newHash !== null && kinds !== undefined) {
        serverBlocked.push({
          path: e.path,
          hash: e.newHash,
          kinds,
          allowDigest: allowDigestOf(allowFingerprintsByHash.get(e.newHash)),
        });
      } else {
        batch.push(e);
      }
    }

    // B3: nothing left to push in this batch slice — skip push()/applyPushResults
    // entirely (an empty `changes` array fails pushRequestSchema's min(1)).
    let batchSkipped = batch.length === 0;

    let roundsDone = 0;
    let batchResponse: Awaited<ReturnType<ParcheClient['push']>> | undefined;
    // Hashes rejected as a secret THIS batch — handled immediately (there is
    // no point retrying the exact same bytes with the exact same exemptions).
    const secretRejected = new Set<string>();
    // Hashes PUT successfully THIS batch, with a count of how many times
    // (review item 5): a hash that succeeded once but the server STILL
    // reports as missing on a LATER round gets ONE retry (2 total PUT
    // attempts) before it's treated as "no further progress possible" —
    // real servers shouldn't do this, but a flaky/eventually-consistent one
    // might, and one extra attempt is cheap insurance against treating that
    // as a hard failure prematurely.
    const putSuccessCount = new Map<string, number>();
    const MAX_PUT_ATTEMPTS_AFTER_SUCCESS = 2;

    // "Nothing more to try for this hash" — either it was rejected as a
    // secret (never retried) or it already got its 2 PUT attempts in.
    const isFullyHandled = (h: string): boolean =>
      secretRejected.has(h) || (putSuccessCount.get(h) ?? 0) >= MAX_PUT_ATTEMPTS_AFTER_SUCCESS;

    while (!batchSkipped) {
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

      // Any missing hash without a local source → cannot complete; don't write state
      const noSource = missingHashes.filter((h) => !blobSource.has(h));
      if (noSource.length > 0) throw missingBlobsError(noSource);

      // Progress-by-containment (B4/N1, review ronda 2; item 5 refines what
      // "handled" means): every missing hash this round is already fully
      // handled (secret-rejected, or already got its 2 PUT attempts) → the
      // server isn't reporting anything actionable, no point retrying.
      // Terminates: when this does NOT throw, at least one hash below is
      // not yet fully handled, so progress strictly accrues every round it's
      // reached — bounded by (distinct hashes × 2 attempts), and
      // MAX_422_ROUNDS is still a hard cap on top regardless.
      if (missingHashes.every((h) => isFullyHandled(h))) {
        throw missingBlobsError(missingHashes);
      }

      // Rounds exhausted → don't write state. With 4+ hashes each reported
      // missing one at a time (never repeating), MAX_422_ROUNDS=3 stops the
      // retry loop here even though every round WAS making progress — the
      // cap is a hard ceiling on total round-trips per batch, independent
      // of whether progress is still happening.
      if (roundsDone >= MAX_422_ROUNDS) throw missingBlobsError(missingHashes);
      roundsDone++;

      // PUT only the reported missing blobs not already fully handled this
      // batch (checkAbort before each one).
      for (const h of missingHashes) {
        if (isFullyHandled(h)) continue;
        const src = blobSource.get(h);
        if (src === undefined) throw missingBlobsError([h]); // unreachable: checked above
        checkAbort(signal);
        const data = await fs.readBytes(src);
        checkAbort(signal);
        try {
          await client.putBlob(h, data, signal, {
            allowFingerprints: allowFingerprintsByHash.get(h),
          });
          putSuccessCount.set(h, (putSuccessCount.get(h) ?? 0) + 1);
        } catch (err) {
          if (!(err instanceof ParcheSecretDetectedError)) throw err;
          secretRejected.add(h);
          rejectedHashes.set(h, err.kinds);
          const allowDigest = allowDigestOf(allowFingerprintsByHash.get(h));
          for (const e of batch) {
            if (e.newHash === h) {
              serverBlocked.push({ path: e.path, hash: h, kinds: err.kinds, allowDigest });
            }
          }
          batch = batch.filter((e) => e.newHash !== h);
        }
      }

      if (batch.length === 0) {
        batchSkipped = true;
        break;
      }
    }

    if (batchSkipped) continue;

    // batchResponse is always assigned before break when !batchSkipped (loop invariant)
    if (batchResponse === undefined) throw new Error('unexpected: no push response for batch');
    currentState = applyPushResults(currentState, batch, batchResponse);
  }

  return { state: currentState, serverBlocked };
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
  needsReindex: boolean;
  derivedConflictsResolved: string[];
}> {
  const { fs, hash } = deps;
  const conflicts: Array<{ path: string; copyPath: string }> = [];
  const movedToTrash: string[] = [];
  const movedToTrashEntries: Array<{ path: string; trashPath: string }> = [];
  const errors: string[] = [];
  const conflictBlobSource = new Map<string, string>();
  const skippedInvalidNames: string[] = [];
  const derivedConflictsResolved: string[] = [];
  let needsReindex = false;
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
        // CHAMBA-016: any write to .md or .base triggers reindex
        if (action.path.endsWith('.md') || action.path.endsWith('.base')) {
          needsReindex = true;
        }
        break;
      }

      case 'conflict': {
        const { path, remoteHash } = action;

        // CHAMBA-015 S10 R2: if the path itself is invalid on Windows, skip entirely.
        // For derived conflicts (no copy written), only the path needs to be valid.
        // We check copyPath validity below only for the normal-conflict branch.
        if (isInvalidPath(path, effectiveStyle)) {
          skippedInvalidNames.push(path);
          break;
        }

        const localAbsPath = joinPath(vaultDir, path);

        // 1. Read local bytes (needed for both derived and normal conflict paths)
        let localBytes: Uint8Array | null;
        try {
          localBytes = await fs.readBytes(localAbsPath);
        } catch {
          // File doesn't exist or can't be read — treat as absent
          localBytes = null;
        }

        // CHAMBA-016: derived-path conflict resolution.
        // Accept remote without creating a copy when:
        //   (a) the path matches isDerivedPathPattern, AND
        //   (b) the local file is chamba-generated (isChambaGenerated) or absent.
        // Human local files (e.g. INDEX.md without source:chamba) → normal flow.
        if (isDerivedPathPattern(path)) {
          const localText = localBytes !== null ? new TextDecoder().decode(localBytes) : '';
          const localIsGenerated = localBytes === null || isChambaGenerated(path, localText);

          if (localIsGenerated) {
            // Accept remote silently — no copy, no conflict entry
            if (remoteHash !== null) {
              let remoteData: Uint8Array;
              try {
                remoteData = await downloadBlob(client, hash, remoteHash, signal);
              } catch (err) {
                errors.push(
                  `Failed to download remote blob for derived conflict "${path}": ${err instanceof Error ? err.message : String(err)}`,
                );
                throw err;
              }
              const dir = localAbsPath.slice(0, localAbsPath.lastIndexOf('/'));
              await fs.mkdir(dir);
              await fs.writeBytes(localAbsPath, remoteData);
            } else {
              // remoteHash === null: tombstone wins → move to trash
              if (localBytes !== null) {
                const trashRelPath = await nextTrashPath(fs, vaultDir, path);
                const trashAbsPath = joinPath(vaultDir, trashRelPath);
                const trashParentDir = trashAbsPath.slice(0, trashAbsPath.lastIndexOf('/'));
                await fs.mkdir(trashParentDir);
                await fs.rename(localAbsPath, trashAbsPath);
                movedToTrash.push(path);
                movedToTrashEntries.push({ path, trashPath: trashRelPath });
              }
            }
            derivedConflictsResolved.push(path);
            needsReindex = true;
            break;
          }
          // Local is human — fall through to normal conflict flow below
        }

        // Normal conflict flow (human file, or non-derived path).
        // Check copyPath validity here — not needed for the derived branch above.
        if (isInvalidPath(action.copyPath, effectiveStyle)) {
          skippedInvalidNames.push(path);
          break;
        }

        // Use empty bytes as fallback if local file is absent (race condition)
        // (file may have changed since scan — use current bytes regardless)
        const localBytesForCopy = localBytes ?? new Uint8Array(0);

        // 2. Write conflict copy (with dedupe)
        const { copyPath: finalCopyPath, bytes: copyBytes } = await writeConflictCopy(
          fs,
          vaultDir,
          action,
          localAuthor,
          localBytesForCopy,
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
        // CHAMBA-016: any conflict on .md/.base also triggers reindex
        if (path.endsWith('.md') || path.endsWith('.base')) {
          needsReindex = true;
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
    needsReindex,
    derivedConflictsResolved,
  };
}

/**
 * Dedup server rejections by path (keep the LAST one seen — phase 3 is more
 * recent than phase 1 for the same path, though in practice a path only
 * appears in one phase per sync) and sort by path, for `SyncSummary.blockedBySecretServer`.
 */
function dedupeServerBlockedForSummary(
  all: ServerBlockedBlob[],
): Array<{ path: string; kinds: string[] }> {
  const byPath = new Map<string, string[]>();
  for (const b of all) byPath.set(b.path, b.kinds);
  return [...byPath.entries()]
    .map(([path, kinds]) => ({ path, kinds }))
    .sort((a, b) => a.path.localeCompare(b.path));
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

  // CHAMBA-023 D-Q3: previous syncedHash per path, so scanLocal can scan for
  // secrets on the SAME bytes it reads to hash each file (no extra read) —
  // only for paths whose content actually changed since the last sync.
  const knownHashes1: Record<string, string | null> = {};
  for (const [p, f] of Object.entries(syncState.files)) knownHashes1[p] = f.syncedHash;

  const {
    snapshot: localSnapshot,
    blobSource,
    findingsByPath: findingsByPath1,
  } = await scanLocal({ fs, hash }, vaultDir, knownHashes1);
  const allPushEntries = planPush(syncState, localSnapshot);

  // CHAMBA-021 S6: screen for un-allowlisted secrets BEFORE pushing. A file
  // with ≥1 finding is excluded entirely from this batch; the rest proceeds.
  const allowlist = await readSecretAllowlist(fs, vaultDir);
  const {
    allowed: pushEntries,
    blocked: blocked1,
    allowFingerprintsByHash: allowFingerprintsByHash1,
  } = await screenPushEntries(
    { fs, hash },
    vaultDir,
    allPushEntries,
    allowlist,
    signal,
    findingsByPath1,
  );

  const now1 = clock.now().toISOString();
  const baseStateFile: SyncStateFile = stateFile ?? {
    server,
    slug,
    cursor: syncState.cursor,
    files: syncState.files,
  };
  let blockedSecretMap = computeBlockedSecretMap(
    baseStateFile.blockedSecret,
    allPushEntries,
    blocked1,
    now1,
  );

  // CHAMBA-023 S4/S5 (D-Q1(b) + B3, owner decision §9 + review ronda 3):
  // hash-based lifecycle for server rejections. While a path's CURRENT local
  // hash AND CURRENT allowDigest (the fingerprints this sync would send in
  // `X-Parche-Secret-Allow` for this content) both still equal what's
  // recorded, skip it WITHOUT a PUT — retrying the exact same bytes with the
  // exact same exemptions would just get the exact same 422. The moment
  // EITHER changes — the file is edited (new hash), OR the user exempted a
  // newly-detected finding for the SAME content via `allow-secret` (new
  // allowDigest, e.g. after a chamba update added a rule that now also
  // matches this file) — fall through to a normal push attempt, so this is
  // never permanently stuck on an unresolved rule mismatch. `rejectedHashes`
  // (hash → kinds) is created ONCE here and shared across every batch AND
  // phase 1/phase 3 below, so a hash rejected in one never gets re-PUT
  // anywhere else this sync.
  const rejectedHashes = new Map<string, string[]>();
  const stillServerBlocked1: ServerBlockedBlob[] = [];
  const pushEntriesAfterServerGate: PushEntry[] = [];
  for (const entry of pushEntries) {
    const recorded = baseStateFile.blockedSecretServer?.[entry.path];
    const currentAllowDigest =
      entry.newHash !== null ? allowDigestOf(allowFingerprintsByHash1.get(entry.newHash)) : '';
    if (
      recorded &&
      entry.newHash !== null &&
      entry.newHash === recorded.hash &&
      currentAllowDigest === recorded.allowDigest
    ) {
      stillServerBlocked1.push({
        path: entry.path,
        hash: recorded.hash,
        kinds: recorded.kinds,
        allowDigest: recorded.allowDigest,
      });
    } else {
      pushEntriesAfterServerGate.push(entry);
    }
  }

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

  let serverBlocked1: ServerBlockedBlob[] = [...stillServerBlocked1];
  if (pushEntriesAfterServerGate.length > 0) {
    const pushResult = await pushAll(
      client,
      slug,
      syncState,
      pushEntriesAfterServerGate,
      blobSource,
      fs,
      batchSize,
      allowFingerprintsByHash1,
      rejectedHashes,
      signal,
    );
    syncState = pushResult.state;
    serverBlocked1 = [...serverBlocked1, ...pushResult.serverBlocked];
  }
  {
    const rejectedPaths1 = new Set(serverBlocked1.map((b) => b.path));
    pushedCount = pushEntries.filter(
      (e) => e.newHash !== null && !rejectedPaths1.has(e.path),
    ).length;
  }

  let serverBlockedMap = computeServerBlockedMap(
    baseStateFile.blockedSecretServer,
    pushEntries,
    serverBlocked1,
    now1,
  );
  // Accumulates every server rejection across phase 1 AND phase 3, for the
  // `SyncSummary.blockedBySecretServer` field (deduplicated/sorted below).
  let blockedBySecretServerAll: ServerBlockedBlob[] = [...serverBlocked1];

  // Save state after phase 1 (preserves any existing skippedPaths from stateFile)
  await writeState(
    fs,
    vaultDir,
    mergeIntoStateFile(
      baseStateFile,
      syncState,
      now1,
      undefined,
      blockedSecretMap,
      serverBlockedMap,
    ),
  );

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
    needsReindex,
    derivedConflictsResolved,
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

  // Save state after phase 2 with the updated skippedPaths. blockedSecretMap /
  // serverBlockedMap are threaded through unchanged (phase 2 doesn't rescan)
  // so they aren't lost — `mergeIntoStateFile` would otherwise fall back to
  // `baseStateFile.blockedSecret`/`blockedSecretServer`, the PRE-phase-1 value.
  const now2 = clock.now().toISOString();
  await writeState(
    fs,
    vaultDir,
    mergeIntoStateFile(
      baseStateFile,
      postPullState,
      now2,
      newSkippedPaths,
      blockedSecretMap,
      serverBlockedMap,
    ),
  );

  // ── Phase 3: Push conflict copies ─────────────────────────────────────────
  let blocked2: Finding[] = [];
  if (conflicts.length > 0) {
    checkAbort(signal);

    // Re-scan to pick up the new copy files. CHAMBA-023 D-Q3: pass
    // postPullState.files as knownHashes so this scanLocal ALSO precomputes
    // findings for every new/changed path (including the freshly written
    // conflict copies — they're not in postPullState.files yet, so they
    // always count as "changed") on the same bytes read for hashing.
    const knownHashes2: Record<string, string | null> = {};
    for (const [p, f] of Object.entries(postPullState.files)) knownHashes2[p] = f.syncedHash;
    const {
      snapshot: localSnapshot2,
      blobSource: blobSource2,
      findingsByPath: findingsByPath2,
    } = await scanLocal({ fs, hash }, vaultDir, knownHashes2);
    // Merge conflict blob sources into blobSource2
    for (const [h, absPath] of conflictBlobSource) {
      blobSource2.set(h, absPath);
    }

    const allPushEntries2 = planPush(postPullState, localSnapshot2);
    // CHAMBA-021 S6: gate conflict-copy pushes too — a conflict copy of a file
    // with a secret is a brand-new local file; without this it would leak
    // through this back door even though phase 1 blocked the original.
    // Falls back to reading the file itself (screenPushEntries) if, for any
    // reason, a pushed path isn't in `findingsByPath2` (e.g. hash mismatch).
    const allowlist2 = await readSecretAllowlist(fs, vaultDir);
    const screened2 = await screenPushEntries(
      { fs, hash },
      vaultDir,
      allPushEntries2,
      allowlist2,
      signal,
      findingsByPath2,
    );
    const pushEntries2 = screened2.allowed;
    blocked2 = screened2.blocked;

    // CHAMBA-023 D-Q1(b) + B3: same hash+allowDigest lifecycle as phase 1 —
    // a conflict copy whose content AND exemptions still match a server
    // rejection is skipped WITHOUT a PUT (and `rejectedHashes` is already
    // shared with phase 1, so a hash rejected there is never retried here
    // either — one PUT per hash per sync, S7.10).
    const stillServerBlocked2: ServerBlockedBlob[] = [];
    const pushEntries2AfterServerGate: PushEntry[] = [];
    for (const entry of pushEntries2) {
      const recorded = serverBlockedMap[entry.path];
      const currentAllowDigest2 =
        entry.newHash !== null
          ? allowDigestOf(screened2.allowFingerprintsByHash.get(entry.newHash))
          : '';
      if (
        recorded &&
        entry.newHash !== null &&
        entry.newHash === recorded.hash &&
        currentAllowDigest2 === recorded.allowDigest
      ) {
        stillServerBlocked2.push({
          path: entry.path,
          hash: recorded.hash,
          kinds: recorded.kinds,
          allowDigest: recorded.allowDigest,
        });
      } else {
        pushEntries2AfterServerGate.push(entry);
      }
    }

    if (pushEntries2.length > 0 || allPushEntries2.length > 0) {
      let phase3State = postPullState;
      let serverBlocked2: ServerBlockedBlob[] = [...stillServerBlocked2];
      if (pushEntries2AfterServerGate.length > 0) {
        try {
          const pushResult2 = await pushAll(
            client,
            slug,
            postPullState,
            pushEntries2AfterServerGate,
            blobSource2,
            fs,
            batchSize,
            screened2.allowFingerprintsByHash,
            rejectedHashes,
            signal,
          );
          phase3State = pushResult2.state;
          serverBlocked2 = [...serverBlocked2, ...pushResult2.serverBlocked];
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
      }

      blockedSecretMap = computeBlockedSecretMap(
        blockedSecretMap,
        allPushEntries2,
        blocked2,
        clock.now().toISOString(),
      );
      serverBlockedMap = computeServerBlockedMap(
        serverBlockedMap,
        pushEntries2,
        serverBlocked2,
        clock.now().toISOString(),
      );
      blockedBySecretServerAll = [...blockedBySecretServerAll, ...serverBlocked2];

      // Save state after phase 3 — pass newSkippedPaths so phase-2 skipped entries
      // are not lost when conflicts cause a re-write of state here.
      const now3 = clock.now().toISOString();
      await writeState(
        fs,
        vaultDir,
        mergeIntoStateFile(
          baseStateFile,
          phase3State,
          now3,
          newSkippedPaths,
          blockedSecretMap,
          serverBlockedMap,
        ),
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
    needsReindex,
    derivedConflictsResolved,
    blockedBySecret: [...blocked1, ...blocked2],
    blockedBySecretServer: dedupeServerBlockedForSummary(blockedBySecretServerAll),
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
  needsReindex: false,
  derivedConflictsResolved: [],
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
