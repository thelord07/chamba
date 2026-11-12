/**
 * parche/provenance.ts — CHAMBA-021 S11: resolve the `author` for a write,
 * without ever reaching for an email.
 *
 * Order (plan §1.5):
 *   1. `user.name` from the active parche vault's credential.
 *   2. `git config user.name` (best-effort; fails silently).
 *   3. `undefined` — the `author` key is simply omitted, never invented.
 */

import type { Services } from '../services.js';
import type { ActiveParcheVaultResult } from './active-vault.js';

/**
 * Resolve the author name for a write-time provenance stamp.
 * Never throws — any failure (missing git, no credential, no name) resolves
 * to `undefined` so the caller omits `author` entirely.
 */
export async function resolveAuthor(
  services: Services,
  vaultResult?: ActiveParcheVaultResult,
): Promise<string | undefined> {
  const fromCred = vaultResult?.kind === 'ok' ? vaultResult.vault.localAuthor?.trim() : undefined;
  if (fromCred) return fromCred;

  try {
    const res = await services.process.exec('git', ['config', 'user.name'], {
      cwd: services.cwd,
    });
    const name = res.stdout.trim();
    if (res.exitCode === 0 && name.length > 0) return name;
  } catch {
    // no git, no config — fall through
  }

  return undefined;
}
