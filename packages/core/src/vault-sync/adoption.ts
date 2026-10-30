/**
 * vault-sync/adoption.ts — builds an adoption summary for the vault gate.
 *
 * Counts syncable and ignored files in a vault directory, and returns a
 * sample of up to 20 paths. Uses the same `isSyncable` filter as `syncOnce`
 * so the count is accurate and consistent with what would actually be pushed.
 *
 * Pure: no Node imports. All IO via FilesystemPort.
 */

import type { FilesystemPort } from '../ports/filesystem.js';
import { joinPath } from '../util/path.js';
import { isSyncable } from './sync-filter.js';

export interface AdoptionSummary {
  /** Files that would be pushed to the server (syncable). */
  syncableCount: number;
  /** Files present in the vault but NOT syncable (ignored by filter). */
  ignoredCount: number;
  /** First ≤20 syncable paths (stable order). */
  sample: string[];
}

/**
 * Walk `vaultDir` and classify each file as syncable or ignored.
 * Returns counts and a sample of up to 20 syncable paths.
 */
export async function buildAdoptionSummary(
  deps: { fs: FilesystemPort },
  vaultDir: string,
): Promise<AdoptionSummary> {
  const { fs } = deps;
  const syncable: string[] = [];
  let totalFiles = 0;

  async function walk(dir: string, relDir: string): Promise<void> {
    let entries: Awaited<ReturnType<FilesystemPort['readDir']>>;
    try {
      entries = await fs.readDir(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const relPath = relDir.length > 0 ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        await walk(joinPath(dir, entry.name), relPath);
      } else if (entry.isFile) {
        const normalizedRel = relPath.normalize('NFC');
        totalFiles++;
        if (isSyncable(normalizedRel)) {
          syncable.push(normalizedRel);
        }
      }
    }
  }

  await walk(vaultDir, '');

  // Sort for stable order
  syncable.sort();

  return {
    syncableCount: syncable.length,
    ignoredCount: totalFiles - syncable.length,
    sample: syncable.slice(0, 20),
  };
}
