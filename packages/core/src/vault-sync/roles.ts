/**
 * vault-sync/roles.ts — role permission table and can() helper.
 * Pure: no Node APIs, no LLM, no auth enforcement (server-side responsibility).
 *
 * Roles (4):
 *   owner  — unique, creator; all actions including delete_group.
 *   admin  — multi-holder; can invite/revoke/change_role except targeting owner;
 *            cannot delete_group.
 *   editor — read, sync, write.
 *   reader — read, sync (pull-only; no write).
 */

import type { Role } from './protocol.js';

export type SyncAction =
  | 'read'
  | 'sync'
  | 'write'
  | 'invite'
  | 'revoke'
  | 'change_role'
  | 'delete_group';

/** Flat permission table (without target-based exceptions). */
export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<SyncAction>> = {
  owner: new Set(['read', 'sync', 'write', 'invite', 'revoke', 'change_role', 'delete_group']),
  admin: new Set(['read', 'sync', 'write', 'invite', 'revoke', 'change_role']),
  editor: new Set(['read', 'sync', 'write']),
  reader: new Set(['read', 'sync']),
};

/**
 * Returns true iff `role` may perform `action`.
 * Optional `target` role: if the action is `revoke` or `change_role` and the
 * target is `owner`, only the owner itself may perform it (admin cannot).
 */
export function can(role: Role, action: SyncAction, target?: Role): boolean {
  if (!ROLE_PERMISSIONS[role].has(action)) return false;
  // Admin cannot revoke or change_role targeting owner
  if (role === 'admin' && (action === 'revoke' || action === 'change_role') && target === 'owner') {
    return false;
  }
  return true;
}
