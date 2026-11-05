/**
 * parche/reindex-state.ts — shared pending-reindex state.
 *
 * Tracks vaults whose post-sync reindex ran out of budget or failed so the
 * next navigate or sync can retry. Extracted from autosync.ts so the
 * vault-navigate tool can share the same set without circular imports.
 */

const _pendingReindex = new Set<string>();

/** Mark a vault as needing a reindex on the next opportunity. */
export function markPendingReindex(vaultDir: string): void {
  _pendingReindex.add(vaultDir);
}

/** Check whether a vault has a pending reindex scheduled. */
export function hasPendingReindex(vaultDir: string): boolean {
  return _pendingReindex.has(vaultDir);
}

/** Consume (remove) the pending flag for a vault. Returns true if it was set. */
export function consumePendingReindex(vaultDir: string): boolean {
  return _pendingReindex.delete(vaultDir);
}

/** Reset all pending reindex state (for tests only). */
export function resetPendingReindex(): void {
  _pendingReindex.clear();
}
