/**
 * vault-sync/state-store.ts — atomic read/write of .chamba-sync/state.json.
 * Pure: no Node imports. Uses FilesystemPort for IO.
 */

import { z } from 'zod';
import type { FilesystemPort } from '../ports/filesystem.js';
import { joinPath } from '../util/path.js';
import type { SyncState } from './plan.js';

// ─── Schema ───────────────────────────────────────────────────────────────────

/**
 * State file schema. `groupId` is added in PARCHE-004 gate decision 1:
 * on join the state is reset with the group id from the join response, so a
 * re-join never inherits state from a previous session.
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
 */
export function mergeIntoStateFile(
  base: SyncStateFile,
  state: SyncState,
  now: string,
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
  return result;
}
