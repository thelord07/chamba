/**
 * vault-sync/state-store.ts — atomic read/write of .chamba-sync/state.json.
 * Pure: no Node imports. Uses FilesystemPort for IO.
 */

import { z } from 'zod';
import type { ClockPort } from '../ports/clock.js';
import type { FilesystemPort } from '../ports/filesystem.js';
import type { HashPort } from '../ports/hash.js';
import { joinPath } from '../util/path.js';
import type { SyncState } from './plan.js';
import type { BlockedSecretMap, ServerBlockedSecretMap } from './secret-gate.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

/**
 * State file schema. `groupId` is added in PARCHE-004 gate decision 1:
 * on join the state is reset with the group id from the join response, so a
 * re-join never inherits state from a previous session.
 *
 * `pendingAdoption` is added in PARCHE-009: when set to `true`, the vault has
 * been joined or linked but the adoption gate has not been confirmed. While this
 * flag is set, `syncOnce` will abort with `AdoptionPendingError` and autosync
 * will skip this vault. The flag is cleared when the user confirms the upload
 * (via `--yes`, TTY "s", or `confirmUpload:true`).
 */
export const syncStateFileSchema = z.object({
  server: z.string().min(1),
  slug: z.string().min(1),
  /**
   * Group ID — set by joinOnce (gate decision 1) to ensure re-join never inherits
   * state from a prior session. Optional for backward compatibility with states
   * written before PARCHE-004 or by syncOnce without a prior join.
   */
  groupId: z.string().optional(),
  cursor: z.number().int().min(0),
  files: z.record(z.string(), z.object({ syncedHash: z.string().nullable() })),
  lastSyncAt: z.string().datetime({ offset: true }).optional(),
  /**
   * PARCHE-009: set to `true` when the vault is pending adoption confirmation.
   * Blocks syncOnce, chamba_vault_sync, and autosync until confirmed.
   */
  pendingAdoption: z.literal(true).optional(),
  /**
   * PARCHE-010 R12/R15: sha256(origin + '\n' + normalizedCode) written by joinOnce.
   * Used to resume a pending join safely without consuming another invite.
   * Never contains the code or token — only the hash.
   */
  pendingJoinCodeHash: z.string().optional(),
  /**
   * CHAMBA-015 S10: paths skipped during pull because the name is invalid on
   * Windows (e.g. contains `<>:"\|?*`, reserved names like CON, trailing space).
   * Maps wire-relative path → last-seen remote hash.
   * Absent when there are no skipped paths (backward-compatible with older states).
   */
  skippedPaths: z.record(z.string(), z.string()).optional(),
  /**
   * CHAMBA-021 S6: vault-relative paths currently excluded from push because
   * the secret scanner found an un-allowlisted finding. Cleared automatically
   * once the file no longer has findings (or is allowlisted) on a later sync.
   * Absent when there are no blocked paths (backward-compatible).
   *
   * `findings` holds EVERY un-allowlisted finding for the path (a file can
   * contain more than one distinct secret), not just the first — each one
   * needs its own fingerprint so `vault allow-secret` can clear it.
   */
  blockedSecret: z
    .record(
      z.string(),
      z.object({
        findings: z
          .array(
            z.object({
              fingerprint: z.string(),
              kind: z.string(),
              line: z.number().int(),
            }),
          )
          .min(1),
        detectedAt: z.string(),
      }),
    )
    .optional()
    // Tolerant: a future/older shape of this map must never invalidate the
    // whole state (that would drop `cursor`/`files` and force a full re-sync).
    .catch(undefined),
  /**
   * CHAMBA-023 S5 (D-Q1, owner decision §9): vault-relative paths currently
   * excluded from push because the SERVER rejected their blob with
   * `422 secret_detected` — distinct from `blockedSecret` above (which is
   * the LOCAL gate's own un-allowlisted findings). No `fingerprint`: the
   * server's 422 only returns `kinds` (CHAMBA-023 plan §1 Open question 4),
   * so this can never be merged into `blockedSecret` without offering a
   * broken `allow-secret` hint.
   *
   * `hash` is the content hash that was rejected. `allowDigest` (review B3)
   * is a fingerprint-only digest of what `X-Parche-Secret-Allow` carried for
   * that hash at rejection time. Hash-based lifecycle (D-Q1(b) + B3): while
   * the path's CURRENT local hash AND current allowDigest still equal
   * `hash`/`allowDigest`, the sync gate skips the PUT entirely (retrying the
   * exact same bytes with the exact same exemptions would just get the exact
   * same 422) and the entry stays in this map. The moment either changes —
   * the file is edited (new hash), OR the user exempts a newly-detected
   * finding for the SAME content via `allow-secret` (new allowDigest) — the
   * entry is cleared and the file is retried normally on the very next sync.
   * It is never permanently stuck as long as one of those two things
   * eventually happens.
   *
   * `kinds` is intentionally NOT `.min(1)` (review B2): the server's 422
   * body is defensively parsed (parche-client.ts) and may legitimately
   * report `kinds: []` (a malformed or minimal response) — requiring at
   * least one element here would make THAT ONE path's garbage shape
   * invalidate the ENTIRE `blockedSecretServer` map on the next `readState`
   * (the whole object fails `.catch(undefined)`), silently un-blocking every
   * other still-rejected path too.
   *
   * Absent when there are no server-blocked paths (backward-compatible).
   */
  blockedSecretServer: z
    .record(
      z.string(),
      z.object({
        kinds: z.array(z.string()),
        hash: z.string(),
        // `.default('')`: an entry missing this field must never invalidate the
        // whole map through the record-level `.catch(undefined)` (review r2).
        allowDigest: z.string().default(''),
        detectedAt: z.string(),
      }),
    )
    .optional()
    // Tolerant for the same reason as `blockedSecret` above.
    .catch(undefined),
});

export type SyncStateFile = z.infer<typeof syncStateFileSchema>;

// ─── Paths ────────────────────────────────────────────────────────────────────

const SYNC_DIR = '.chamba-sync';
const STATE_FILE = 'state.json';

function stateFilePath(vaultDir: string): string {
  return joinPath(vaultDir, SYNC_DIR, STATE_FILE);
}

// ─── Read / Write ─────────────────────────────────────────────────────────────

/**
 * Read the sync state from `<vaultDir>/.chamba-sync/state.json`.
 * Returns `null` if the file does not exist or is invalid.
 */
export async function readState(
  fs: FilesystemPort,
  vaultDir: string,
): Promise<SyncStateFile | null> {
  const path = stateFilePath(vaultDir);
  let text: string;
  try {
    text = await fs.readFile(path);
  } catch {
    return null;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const result = syncStateFileSchema.safeParse(json);
  return result.success ? result.data : null;
}

/**
 * Write the sync state atomically to `<vaultDir>/.chamba-sync/state.json`.
 */
export async function writeState(
  fs: FilesystemPort,
  vaultDir: string,
  state: SyncStateFile,
): Promise<void> {
  const dir = joinPath(vaultDir, SYNC_DIR);
  await fs.mkdir(dir);
  const path = stateFilePath(vaultDir);
  const data = new TextEncoder().encode(JSON.stringify(state, null, 2));
  await fs.writeBytes(path, data);
}

/**
 * Convert a `SyncStateFile` (disk format) to the `SyncState` used by plan functions.
 */
export function toSyncState(file: SyncStateFile): SyncState {
  return {
    cursor: file.cursor,
    files: file.files,
  };
}

/**
 * Merge a `SyncState` (from plan functions) back into a `SyncStateFile` for saving.
 * Preserves `pendingAdoption`, `pendingJoinCodeHash`, and `skippedPaths` flags from
 * base (each cleared separately by dedicated helpers).
 *
 * @param newSkippedPaths - When provided, replaces the `skippedPaths` map (phase-2
 *   write). When absent, the base value is preserved (phases 1 and 3).
 * @param newBlockedSecret - Same semantics as `newSkippedPaths`, for the
 *   `blockedSecret` map (CHAMBA-021 S6). Pass the freshly computed map on every
 *   write the gate ran for (phases 1 and 3); phase 2 should pass through the
 *   same map computed after phase 1 so it isn't lost.
 * @param newBlockedSecretServer - Same semantics, for the `blockedSecretServer`
 *   map (CHAMBA-023 S5) — server-side `422 secret_detected` rejections.
 */
export function mergeIntoStateFile(
  base: SyncStateFile,
  state: SyncState,
  now: string,
  newSkippedPaths?: Record<string, string>,
  newBlockedSecret?: BlockedSecretMap,
  newBlockedSecretServer?: ServerBlockedSecretMap,
): SyncStateFile {
  const result: SyncStateFile = {
    server: base.server,
    slug: base.slug,
    cursor: state.cursor,
    files: state.files,
    lastSyncAt: now,
  };
  if (base.groupId !== undefined) {
    result.groupId = base.groupId;
  }
  // Preserve pendingAdoption (only cleared explicitly by the gate logic)
  if (base.pendingAdoption === true) {
    result.pendingAdoption = true;
  }
  // Preserve pendingJoinCodeHash (only cleared by clearPendingAdoption)
  if (base.pendingJoinCodeHash !== undefined) {
    result.pendingJoinCodeHash = base.pendingJoinCodeHash;
  }
  // skippedPaths: use newSkippedPaths when provided (phase-2 write);
  // otherwise preserve from base (phases 1 and 3).
  const effectiveSkipped = newSkippedPaths ?? base.skippedPaths;
  if (effectiveSkipped && Object.keys(effectiveSkipped).length > 0) {
    result.skippedPaths = effectiveSkipped;
  }
  const effectiveBlockedSecret = newBlockedSecret ?? base.blockedSecret;
  if (effectiveBlockedSecret && Object.keys(effectiveBlockedSecret).length > 0) {
    result.blockedSecret = effectiveBlockedSecret;
  }
  const effectiveBlockedSecretServer = newBlockedSecretServer ?? base.blockedSecretServer;
  if (effectiveBlockedSecretServer && Object.keys(effectiveBlockedSecretServer).length > 0) {
    result.blockedSecretServer = effectiveBlockedSecretServer;
  }
  return result;
}

/**
 * Reset the vault state to a fresh (cursor=0, files={}) state.
 * Always sets `pendingAdoption: true` — the caller must clear it after
 * gate confirmation.
 * Used by joinOnce (after server join) and vault link (re-link to new dir).
 *
 * PARCHE-010 R15: `meta.pendingJoinCodeHash` is written in the same step when
 * provided (joinOnce passes it; link/resync do not).
 */
export async function resetVaultState(
  fs: FilesystemPort,
  vaultDir: string,
  meta: { server: string; slug: string; groupId?: string; pendingJoinCodeHash?: string },
  clock: ClockPort,
): Promise<SyncStateFile> {
  const state: SyncStateFile = {
    server: meta.server,
    slug: meta.slug,
    cursor: 0,
    files: {},
    lastSyncAt: clock.now().toISOString(),
    pendingAdoption: true,
  };
  if (meta.groupId !== undefined) {
    state.groupId = meta.groupId;
  }
  if (meta.pendingJoinCodeHash !== undefined) {
    state.pendingJoinCodeHash = meta.pendingJoinCodeHash;
  }
  await writeState(fs, vaultDir, state);
  return state;
}

/**
 * Clear the `pendingAdoption` and `pendingJoinCodeHash` fields from a state object.
 * Returns the mutated copy (does NOT write to disk — caller must call writeState).
 *
 * PARCHE-010 R12: all gate-confirmation paths call this helper to ensure both
 * fields are cleared atomically.
 */
export function clearPendingAdoption(state: SyncStateFile): SyncStateFile {
  const cleared = { ...state };
  delete cleared.pendingAdoption;
  delete cleared.pendingJoinCodeHash;
  return cleared;
}

/**
 * Compute the `pendingJoinCodeHash` for a given server + normalized code.
 * Formula: sha256(utf8(`${origin}\n${code}`)) — hex.
 *
 * PARCHE-010 R15: single implementation used by both joinOnce (writer) and
 * the resume path in binding-ops (verifier).
 */
export async function pendingJoinCodeHashOf(
  hash: HashPort,
  server: string,
  normalizedCode: string,
): Promise<string> {
  const origin = new URL(server).origin;
  const data = new TextEncoder().encode(`${origin}\n${normalizedCode}`);
  return hash.sha256(data);
}
