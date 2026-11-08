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
import type { HashPort } from '../ports/hash.js';
import { isSecretAllowed, readSecretAllowlist } from '../secrets/allowlist.js';
import type { Finding } from '../secrets/scanner.js';
import { isScannable, scanText } from '../secrets/scanner.js';
import { joinPath } from '../util/path.js';
import { isSyncable } from './sync-filter.js';

export interface AdoptionSummary {
  /** Files that would be pushed to the server (syncable). */
  syncableCount: number;
  /** Files present in the vault but NOT syncable (ignored by filter). */
  ignoredCount: number;
  /** First ≤20 syncable paths (stable order). */
  sample: string[];
  /**
   * CHAMBA-021 S7: findings for syncable files with an un-allowlisted secret.
   * Reporting only — the real exclusion happens at `syncOnce`'s secret gate
   * (`secret-gate.ts`). Always `[]` when `deps.hash` is not provided (backward
   * compatibility with callers that don't scan). A finding already marked a
   * false positive in the local `secret-allowlist.json` is excluded here too.
   */
  blocked: Finding[];
  /** `blocked.length`, kept as its own field for cheap structured output. */
  blockedCount: number;
}

/**
 * Walk `vaultDir` and classify each file as syncable or ignored.
 * Returns counts and a sample of up to 20 syncable paths.
 *
 * hot-path (CHAMBA-021 §6): when `deps.hash` is provided, every syncable +
 * scannable file is scanned in this SAME walk (no second pass over the vault).
 */
export async function buildAdoptionSummary(
  deps: { fs: FilesystemPort; hash?: HashPort },
  vaultDir: string,
): Promise<AdoptionSummary> {
  const { fs, hash } = deps;
  const syncable: string[] = [];
  const blocked: Finding[] = [];
  let totalFiles = 0;
  const allowlist = hash ? await readSecretAllowlist(fs, vaultDir) : undefined;

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
          if (hash && isScannable(normalizedRel)) {
            try {
              const text = await fs.readFile(joinPath(vaultDir, normalizedRel));
              const findings = await scanText({ hash }, text, normalizedRel);
              const unallowed = allowlist
                ? findings.filter((f) => !isSecretAllowed(allowlist, f.path, f.fingerprint))
                : findings;
              blocked.push(...unallowed);
            } catch {
              // Unreadable — nothing to scan; the sync gate will surface the error.
            }
          }
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
    blocked,
    blockedCount: blocked.length,
  };
}
