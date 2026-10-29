/**
 * parche/autosync.ts — best-effort auto-sync helper used by MCP tools.
 *
 * `maybeAutoSync` wraps syncOnce in a try/catch and enforces a hard budget.
 * It never throws: if the sync fails or times out, the caller receives a
 * warning string and can append it to its normal response.
 */

import { syncOnce } from '@chamba/core';
import type { Logger } from 'pino';
import type { Services } from '../services.js';
import type { ActiveParcheVault } from './active-vault.js';
import { withVaultLock } from './mutex.js';

/**
 * Total time budget for an auto-sync triggered by a tool call.
 *
 * This is a fixed constant rather than an env var for several reasons:
 *  - The value (10 s) is chosen to keep tool latency acceptable while
 *    allowing a full push+pull cycle on fast connections.
 *  - Making it configurable would create an implicit API surface that is hard
 *    to document and test. PARCHE-003 review noted that too many env knobs
 *    complicate reasoning about timing guarantees.
 *  - CLI `vault sync` and the `chamba_vault_sync` tool have no budget and are
 *    the right choice when a user wants a reliable, unbounded sync.
 */
export const AUTOSYNC_BUDGET_MS = 10_000;

/** Result returned by maybeAutoSync. */
export interface AutoSyncResult {
  synced: boolean;
  /** Human-readable warning to append to the tool response, if the sync failed. */
  warning?: string;
}

/**
 * Run a best-effort sync bounded by `AUTOSYNC_BUDGET_MS`.
 *
 * @param services  - Injected services (fs, http, hash, clock, mutex).
 * @param logger    - Pino logger; token is never passed here.
 * @param vault     - Active parche vault data (resolved by resolveActiveParcheVault).
 * @param phase     - 'push' for post-write, 'pull' for pre-read.
 *                    When `phase === 'pull'`, the sync is skipped if
 *                    `lastSyncAt` is within `parchePullTtlMin` minutes.
 */
export async function maybeAutoSync(
  services: Services,
  logger: Logger,
  vault: ActiveParcheVault,
  phase: 'push' | 'pull',
): Promise<AutoSyncResult> {
  // Pull-phase TTL check: skip if last sync is recent enough
  if (phase === 'pull' && vault.lastSyncAt) {
    const elapsed =
      (services.clock.now().getTime() - new Date(vault.lastSyncAt).getTime()) / 60_000;
    if (elapsed < services.parchePullTtlMin) {
      return { synced: false };
    }
  }

  // Per-vault mutex: skip if another sync is already running (best-effort autosync)
  const mutexKey = `${vault.server}|${vault.slug}`;
  const budgetMs = services.autosyncBudgetMs ?? AUTOSYNC_BUDGET_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);

  const lockResult = await withVaultLock(
    services.vaultMutex,
    mutexKey,
    { onBusy: 'skip', logger, label: vault.slug },
    async () => {
      try {
        await syncOnce(
          { fs: services.fs, http: services.http, hash: services.hash, clock: services.clock },
          {
            vaultDir: vault.vaultDir,
            server: vault.server,
            slug: vault.slug,
            token: vault.token,
            localAuthor: vault.localAuthor,
            device: vault.device,
            signal: controller.signal,
          },
        );
        logger.info({ tool: 'autosync', slug: vault.slug, phase }, 'auto-sync completed');
        return { ok: true as const, signal: controller.signal };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ tool: 'autosync', slug: vault.slug, phase, err: msg }, 'auto-sync failed');
        return { ok: false as const, msg, signal: controller.signal };
      } finally {
        clearTimeout(timer);
      }
    },
  ).catch((err: unknown) => {
    // Should not happen, but guard defensively
    const msg = err instanceof Error ? err.message : String(err);
    return {
      skipped: false as const,
      result: { ok: false as const, msg, signal: controller.signal },
    };
  });

  if (lockResult.skipped) {
    clearTimeout(timer);
    return { synced: false, warning: 'sync skipped: another sync is already running' };
  }

  const inner = lockResult.result;
  if (!inner?.ok) {
    return {
      synced: false,
      warning: `auto-sync pausado: ${inner?.msg ?? 'unknown error'}. Usa \`vault sync\` para sincronizar manualmente.`,
    };
  }
  return { synced: true };
}
