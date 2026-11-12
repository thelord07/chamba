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
import { scanText, shouldScanContent } from '../secrets/scanner.js';
import { joinPath } from '../util/path.js';
import type { PushEntry } from './plan.js';

/**
 * CHAMBA-023 D-Q3 (owner decision §9): "reuse the bytes already read for the
 * hash — no extra read". `scanLocal` (runner.ts) already reads every local
 * file's bytes once to compute its hash; when it also has `knownHashes` (the
 * previous `syncedHash` per path) it can tell IN THAT SAME WALK whether a
 * file changed and, if so, run `scanText` right there, on the bytes it just
 * decoded for the hash — no buffer is retained past that single iteration,
 * so this adds no new memory cost. `screenPushEntries` then looks this up
 * BY HASH instead of re-reading the file.
 *
 * `scanned: false` marks a file `scanLocal` decided NOT to scan (binary, too
 * big, or invalid UTF-8 per `shouldScanContent`) — distinct from "scanned
 * and found nothing" (`scanned: true`, `findings: []`), so `screenPushEntries`
 * never re-reads a file just to re-discover it isn't scannable.
 */
export interface PrecomputedFileFindings {
  hash: string;
  findings: Finding[];
  scanned: boolean;
}

export interface ScreenPushResult {
  /** Entries that may proceed to `pushAll` (unaffected or exempted). */
  allowed: PushEntry[];
  /** Un-allowlisted findings for excluded entries (one or more per path). */
  blocked: Finding[];
  /**
   * CHAMBA-023 S3: for every ALLOWED entry that had ≥1 (exempted) finding,
   * the fingerprints of those findings, keyed by `entry.newHash`.
   *
   * Only fingerprints for entries that passed the gate land here — an entry
   * with even one un-allowlisted finding is excluded entirely (see `blocked`
   * above) and contributes nothing to this map. `putBlob` sends exactly this
   * list in `X-Parche-Secret-Allow` (parche-client.ts) so the server's own
   * scan can skip findings the user already reviewed — never the whole
   * local allowlist, never another path's fingerprints.
   *
   * Keyed by hash, not path (CHAMBA-023 plan §1.2): the fingerprint set is a
   * pure function of content (`fingerprint = sha256(kind + value)`, path-
   * independent), and a path only reaches `allowed` once ALL of its findings
   * are exempted. So two different paths that happen to share a hash (same
   * bytes) necessarily have the EXACT SAME finding set, and the union of
   * their individually-exempted fingerprints equals that same set — sending
   * the union is correct and never leaks one path's exemption onto another
   * path's un-exempted content.
   */
  allowFingerprintsByHash: Map<string, string[]>;
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
 *
 * CHAMBA-023 D-Q3: `precomputed` (built by `scanLocal`, runner.ts, from the
 * SAME bytes it already read to hash each file) is consulted first, BY HASH
 * (`precomputed.get(entry.path)?.hash === entry.newHash`) — a hash match
 * means these are exactly the bytes that produced `entry.newHash`, so the
 * findings are guaranteed to correspond to what's actually being pushed
 * (closes part of the CHAMBA-021 TOCTOU gap: no separate re-read that could
 * race against a concurrent edit). When there's no entry for this path (e.g.
 * a phase-3 conflict copy `scanLocal` didn't walk) or the hash doesn't match
 * (content changed again since the precompute pass), this falls back to
 * reading the file itself — identical to the pre-D-Q3 behavior.
 */
export async function screenPushEntries(
  deps: { fs: FilesystemPort; hash: HashPort },
  vaultDir: string,
  entries: PushEntry[],
  allowlist: SecretAllowlist,
  signal?: AbortSignal,
  precomputed?: Map<string, PrecomputedFileFindings>,
): Promise<ScreenPushResult> {
  const { fs, hash } = deps;
  const allowed: PushEntry[] = [];
  const blocked: Finding[] = [];
  const allowFingerprintsByHash = new Map<string, Set<string>>();

  for (const entry of entries) {
    checkAbort(signal);

    if (entry.newHash === null) {
      allowed.push(entry);
      continue;
    }

    const pre = precomputed?.get(entry.path);
    let findings: Finding[];

    if (pre && pre.hash === entry.newHash) {
      if (!pre.scanned) {
        // scanLocal already determined these bytes aren't scannable
        // (binary, too big, or invalid UTF-8) — nothing to re-check.
        allowed.push(entry);
        continue;
      }
      findings = pre.findings;
    } else {
      // Fallback: no precompute for this path/hash — read and scan it here,
      // exactly as before D-Q3. Scan by CONTENT, not by extension: any
      // syncable file (`.pdf`, `.png`, …) can be rejected by the server's
      // own content-based scan, so the local gate must agree on what
      // "scannable" means.
      let bytes: Uint8Array;
      try {
        bytes = await fs.readBytes(joinPath(vaultDir, entry.path));
      } catch {
        // Can't read it — let the push itself surface the error.
        allowed.push(entry);
        continue;
      }

      const text = shouldScanContent(bytes, entry.path);
      if (text === null) {
        allowed.push(entry);
        continue;
      }

      findings = await scanText({ hash }, text, entry.path);
    }

    const unallowed = findings.filter((f) => !isSecretAllowed(allowlist, f.path, f.fingerprint));

    if (unallowed.length > 0) {
      blocked.push(...unallowed);
      continue;
    }

    if (findings.length > 0) {
      let set = allowFingerprintsByHash.get(entry.newHash);
      if (!set) {
        set = new Set();
        allowFingerprintsByHash.set(entry.newHash, set);
      }
      for (const f of findings) set.add(f.fingerprint);
    }

    allowed.push(entry);
  }

  return {
    allowed,
    blocked,
    allowFingerprintsByHash: new Map(
      [...allowFingerprintsByHash].map(([h, set]) => [h, [...set].sort()]),
    ),
  };
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

// ─── Server-side rejection (CHAMBA-023 S4/S5) ────────────────────────────────

/**
 * CHAMBA-023 review (B3): a fingerprint-only digest of what was sent in
 * `X-Parche-Secret-Allow` for a hash, so the hash-based "skip without a PUT"
 * lifecycle (D-Q1(b)) can detect "the bytes are the same, but what the user
 * has exempted for them changed" — e.g. a newer chamba version adds a rule
 * that now also matches this unchanged file, the user runs `allow-secret` on
 * the new finding, and the set of fingerprints sent to the server grows,
 * even though the file's hash never moved. Never includes a value — only
 * the 12-hex fingerprints already present in `allowFingerprintsByHash`.
 * Deterministic: sorted, then joined with `,` (empty string when there are
 * no fingerprints for this hash).
 */
export function allowDigestOf(fingerprints: readonly string[] | undefined): string {
  return fingerprints === undefined ? '' : [...fingerprints].sort().join(',');
}

/**
 * One blob the SERVER rejected with `422 secret_detected` for a given sync
 * pass — recorded per path (a path can share its hash with another path,
 * see `pushAll` in runner.ts, so the same blob can produce one entry per
 * path). `kinds` comes straight from the server's response; there is no
 * fingerprint (the protocol doesn't return one — CHAMBA-023 plan §1 Open
 * question 4) so this is intentionally NOT a `Finding` and never merged into
 * `blockedSecret`/`BlockedSecretMap` (D-Q1, owner decision §9): mixing the
 * two would offer a broken `allow-secret` hint for something it cannot clear.
 *
 * `allowDigest` (B3 fix) is `allowDigestOf` of the fingerprints THIS sync
 * sent for this hash — see the hash-based lifecycle note on
 * `ServerBlockedSecretEntry` for why this matters.
 */
export interface ServerBlockedBlob {
  path: string;
  hash: string;
  kinds: string[];
  allowDigest: string;
}

/**
 * One server rejection recorded in state, keyed by path (CHAMBA-023 S5).
 *
 * B3 fix (review ronda 3): the hash alone is NOT enough to know the server
 * would give the exact same verdict again — the server's decision depends on
 * the content HASH **and** the `X-Parche-Secret-Allow` header sent with it.
 * `allowDigest` is `allowDigestOf` of that header's fingerprints at the time
 * of this rejection. The sync gate (runner.ts) only skips a path WITHOUT a
 * PUT when BOTH the current hash AND the current allowDigest still match
 * this entry; if either changed — the file was edited (new hash), OR the
 * user ran `allow-secret` on a newly-detected finding for the SAME content
 * (new allowDigest, e.g. a chamba update added a rule that now also matches
 * this file) — the path is retried normally. So this is never permanently
 * stuck as long as the user either edits the file OR changes what's
 * exempted for it; staying on the exact same hash+allowDigest forever is the
 * only way it stays blocked (correctly — nothing changed, so nothing new to
 * try).
 */
export interface ServerBlockedSecretEntry {
  kinds: string[];
  hash: string;
  allowDigest: string;
  detectedAt: string;
}

export type ServerBlockedSecretMap = Record<string, ServerBlockedSecretEntry>;

/**
 * Recompute the `blockedSecretServer` map after a push pass — mirrors
 * `computeBlockedSecretMap` exactly, but for server-side (not local)
 * rejections.
 *
 * For every path that was *evaluated* this pass (present in `evaluatedEntries`,
 * i.e. it was part of the push attempt — including a path skipped WITHOUT a
 * PUT because its hash AND allowDigest still match a previous rejection,
 * D-Q1(b)/B3):
 *   - if the server rejected it (present in `serverBlocked`) → record it.
 *     `detectedAt` is preserved from `base` when hash AND allowDigest are
 *     BOTH unchanged from the previous entry (nothing new happened — this is
 *     the same ongoing block, not a fresh detection); otherwise it's `now`
 *     (review item 7).
 *   - otherwise → remove it from the map (the server accepted it this time —
 *     content changed and is now clean, or the push simply never reached the
 *     server because an earlier guard aborted first).
 * Paths not evaluated this pass keep whatever was in `base` untouched.
 */
export function computeServerBlockedMap(
  base: ServerBlockedSecretMap | undefined,
  evaluatedEntries: PushEntry[],
  serverBlocked: ServerBlockedBlob[],
  now: string,
): ServerBlockedSecretMap {
  const result = { ...(base ?? {}) };
  const blockedByPath = new Map<string, ServerBlockedBlob>();
  for (const b of serverBlocked) blockedByPath.set(b.path, b);
  for (const entry of evaluatedEntries) {
    const found = blockedByPath.get(entry.path);
    if (found) {
      const prev = result[entry.path];
      const unchanged =
        prev !== undefined && prev.hash === found.hash && prev.allowDigest === found.allowDigest;
      result[entry.path] = {
        kinds: found.kinds,
        hash: found.hash,
        allowDigest: found.allowDigest,
        detectedAt: unchanged ? prev.detectedAt : now,
      };
    } else {
      delete result[entry.path];
    }
  }
  return result;
}
