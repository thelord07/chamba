/**
 * parche/mutex.ts — per-vault mutex helper.
 *
 * `withVaultLock` centralises the Map<string, Promise<void>> locking pattern
 * that `vault-sync.ts` (wait) and `autosync.ts` (skip) both need.
 */

import type { Logger } from 'pino';

export type OnBusyStrategy = 'wait' | 'skip';

export interface VaultLockOptions {
  /**
   * What to do when the mutex is already held.
   * - `'wait'` — queue behind the running sync (used by the explicit `chamba_vault_sync` tool).
   * - `'skip'` — return immediately with `{ skipped: true }` (used by best-effort autosync).
   */
  onBusy: OnBusyStrategy;
  /** Optional logger for the skip warning. */
  logger?: Logger;
  /** Human-readable identifier for log messages (e.g. the slug). */
  label?: string;
}

export interface VaultLockResult<T> {
  skipped: boolean;
  result?: T;
}

/**
 * Acquire the per-vault mutex keyed by `key` in `mutex`, run `fn`, then release.
 *
 * @returns `{ skipped: false, result }` on success;
 *          `{ skipped: true }` when `onBusy === 'skip'` and the lock was held.
 */
export async function withVaultLock<T>(
  mutex: Map<string, Promise<void>>,
  key: string,
  opts: VaultLockOptions,
  fn: () => Promise<T>,
): Promise<VaultLockResult<T>> {
  let pending = mutex.get(key);

  if (pending && opts.onBusy === 'skip') {
    opts.logger?.warn(
      { mutexKey: key, label: opts.label },
      'vault sync skipped: another sync is already running',
    );
    return { skipped: true };
  }
  // 'wait': re-check after every wake-up. Several waiters can be woken by the same
  // release; only the first to run sets the lock, the rest see it and keep waiting.
  while (pending) {
    await pending;
    pending = mutex.get(key);
  }

  let resolve: () => void = () => undefined;
  const lock = new Promise<void>((r) => {
    resolve = r;
  });
  mutex.set(key, lock);

  try {
    const result = await fn();
    return { skipped: false, result };
  } finally {
    mutex.delete(key);
    resolve();
  }
}
