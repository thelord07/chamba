/**
 * secrets/allowlist.ts — local, non-synced false-positive allowlist (CHAMBA-021 S3).
 *
 * Lives at `<vaultDir>/.chamba-sync/secret-allowlist.json`. `.chamba-sync/` is
 * already excluded from sync (`sync-filter.ts`'s denylist matches any segment
 * starting with `.chamba-sync`), so this file never leaves the machine.
 *
 * Pure: no Node imports. All IO via `FilesystemPort`; atomic write like
 * `state-store.ts` (`fs.writeBytes`).
 */

import { z } from 'zod';
import type { ClockPort } from '../ports/clock.js';
import type { FilesystemPort } from '../ports/filesystem.js';
import { joinPath } from '../util/path.js';

const secretAllowEntrySchema = z.object({
  path: z.string().min(1),
  fingerprint: z.string().min(1),
  addedAt: z.string(),
});

export const secretAllowlistSchema = z.object({
  version: z.literal(1),
  entries: z.array(secretAllowEntrySchema),
});

export type SecretAllowEntry = z.infer<typeof secretAllowEntrySchema>;
export type SecretAllowlist = z.infer<typeof secretAllowlistSchema>;

const SYNC_DIR = '.chamba-sync';
const ALLOWLIST_FILE = 'secret-allowlist.json';

const EMPTY_ALLOWLIST: SecretAllowlist = { version: 1, entries: [] };

function allowlistPath(vaultDir: string): string {
  return joinPath(vaultDir, SYNC_DIR, ALLOWLIST_FILE);
}

/**
 * Read the allowlist. Tolerant like `readState`: a missing or invalid file
 * returns the empty allowlist rather than throwing.
 */
export async function readSecretAllowlist(
  fs: FilesystemPort,
  vaultDir: string,
): Promise<SecretAllowlist> {
  const path = allowlistPath(vaultDir);
  let text: string;
  try {
    text = await fs.readFile(path);
  } catch {
    return EMPTY_ALLOWLIST;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return EMPTY_ALLOWLIST;
  }
  const result = secretAllowlistSchema.safeParse(json);
  return result.success ? result.data : EMPTY_ALLOWLIST;
}

/**
 * Add an allowlist entry for `{path, fingerprint}` — idempotent (calling twice
 * does not duplicate the entry). Writes atomically via `fs.writeBytes`.
 */
export async function addSecretAllowEntry(
  fs: FilesystemPort,
  clock: ClockPort,
  vaultDir: string,
  entry: { path: string; fingerprint: string },
): Promise<SecretAllowlist> {
  const current = await readSecretAllowlist(fs, vaultDir);
  const normalizedPath = entry.path.normalize('NFC');
  const already = current.entries.some(
    (e) => e.path === normalizedPath && e.fingerprint === entry.fingerprint,
  );
  const next: SecretAllowlist = already
    ? current
    : {
        version: 1,
        entries: [
          ...current.entries,
          {
            path: normalizedPath,
            fingerprint: entry.fingerprint,
            addedAt: clock.now().toISOString(),
          },
        ],
      };

  if (!already) {
    const dir = joinPath(vaultDir, SYNC_DIR);
    await fs.mkdir(dir);
    const path = allowlistPath(vaultDir);
    const data = new TextEncoder().encode(JSON.stringify(next, null, 2));
    await fs.writeBytes(path, data);
  }

  return next;
}

/**
 * True when `(path, fingerprint)` is exempted by the allowlist. Both compared
 * exactly (path NFC-normalized) — an entry never exempts another path or
 * another fingerprint at the same path.
 */
export function isSecretAllowed(
  allowlist: SecretAllowlist,
  path: string,
  fingerprint: string,
): boolean {
  const normalizedPath = path.normalize('NFC');
  return allowlist.entries.some((e) => e.path === normalizedPath && e.fingerprint === fingerprint);
}
