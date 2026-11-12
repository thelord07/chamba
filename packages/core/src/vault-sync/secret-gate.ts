/**
 * vault-sync/secret-gate.ts — blocks a push entry whose content has an
 * un-allowlisted secret finding (CHAMBA-021 S6).
 *
 * Wired into `syncOnce` at phase 1 (normal push) and phase 3 (conflict-copy
 * push) — gate decision 1 in the CHAMBA-021 plan: without phase 3 a secret in
 * a file that conflicts would leak through the conflict-copy back door.
 *
 * hot-path: only entries with a local change (`newHash !== null`) AND a
 * scannable extension are read; tombstones and binaries always pass through
 * untouched. Processed sequentially (no `Promise.all`) so it never exhausts
 * file descriptors on a large batch, with `checkAbort` per entry like `pushAll`.
 *
 * Pure: no Node imports. All IO via `FilesystemPort`/`HashPort`.
 */

import type { FilesystemPort } from '../ports/filesystem.js';
import type { HashPort } from '../ports/hash.js';
import type { SecretAllowlist } from '../secrets/allowlist.js';
import { isSecretAllowed } from '../secrets/allowlist.js';
import type { Finding } from '../secrets/scanner.js';
import { isScannable, scanText } from '../secrets/scanner.js';
import { joinPath } from '../util/path.js';
import type { PushEntry } from './plan.js';

export interface ScreenPushResult {
  /** Entries that may proceed to `pushAll` (unaffected or exempted). */
  allowed: PushEntry[];
  /** Un-allowlisted findings for excluded entries (one or more per path). */
  blocked: Finding[];
}

/** One finding recorded for a blocked path — never the value, only its fingerprint. */
export interface BlockedSecretFinding {
  fingerprint: string;
  kind: string;
  line: number;
}

/**
 * All findings recorded for one blocked path (CHAMBA-021 review: a path can
 * have several distinct secrets — keep every one of them so each can be
 * allowlisted individually, instead of only the first).
 */
export interface BlockedSecretEntry {
  findings: BlockedSecretFinding[];
  detectedAt: string;
}

export type BlockedSecretMap = Record<string, BlockedSecretEntry>;

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Sync aborted', 'AbortError');
  }
}

/**
 * Screen push entries for secrets. An entry with ≥1 un-allowlisted finding is
 * excluded from `allowed` entirely (the whole file, not just the matched
 * line) — the rest of the batch proceeds normally.
 */
export async function screenPushEntries(
  deps: { fs: FilesystemPort; hash: HashPort },
  vaultDir: string,
  entries: PushEntry[],
  allowlist: SecretAllowlist,
  signal?: AbortSignal,
): Promise<ScreenPushResult> {
  const { fs, hash } = deps;
  const allowed: PushEntry[] = [];
  const blocked: Finding[] = [];

  for (const entry of entries) {
    checkAbort(signal);

    if (entry.newHash === null || !isScannable(entry.path)) {
      allowed.push(entry);
      continue;
    }

    let text: string;
    try {
      text = await fs.readFile(joinPath(vaultDir, entry.path));
    } catch {
      // Can't read it — let the push itself surface the error.
      allowed.push(entry);
      continue;
    }

    const findings = await scanText({ hash }, text, entry.path);
    const unallowed = findings.filter((f) => !isSecretAllowed(allowlist, f.path, f.fingerprint));

    if (unallowed.length > 0) {
      blocked.push(...unallowed);
      continue;
    }

    allowed.push(entry);
  }

  return { allowed, blocked };
}

/**
 * Recompute the `blockedSecret` map after a screening pass.
 *
 * For every path that was *evaluated* this pass (i.e. present in `entries`):
 *   - if it has ≥1 blocked finding → record ALL of them (not just the first —
 *     a file can contain several distinct secrets, and every one needs its
 *     own fingerprint so `vault allow-secret` can clear them individually).
 *   - otherwise → remove it from the map (resolved, allowlisted, or a
 *     tombstone that now passes through).
 * Paths not evaluated this pass (not in `entries`) keep whatever was in
 * `base` — they weren't rescanned.
 */
export function computeBlockedSecretMap(
  base: BlockedSecretMap | undefined,
  entries: PushEntry[],
  blocked: Finding[],
  now: string,
): BlockedSecretMap {
  const result = { ...(base ?? {}) };
  const blockedByPath = new Map<string, Finding[]>();
  for (const f of blocked) {
    const existing = blockedByPath.get(f.path);
    if (existing) existing.push(f);
    else blockedByPath.set(f.path, [f]);
  }
  for (const entry of entries) {
    const found = blockedByPath.get(entry.path);
    if (found && found.length > 0) {
      result[entry.path] = {
        findings: found.map((f) => ({ fingerprint: f.fingerprint, kind: f.kind, line: f.line })),
        detectedAt: now,
      };
    } else {
      delete result[entry.path];
    }
  }
  return result;
}
