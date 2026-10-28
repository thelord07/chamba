import { describe, expect, it } from 'vitest';
import type { Role } from './protocol.js';
import { can, ROLE_PERMISSIONS, type SyncAction } from './roles.js';

const ROLES: Role[] = ['owner', 'admin', 'editor', 'reader'];
const ACTIONS: SyncAction[] = [
  'read',
  'sync',
  'write',
  'invite',
  'revoke',
  'change_role',
  'delete_group',
];

// Expected permission matrix (role → allowed actions, without target exceptions)
const EXPECTED_MATRIX: Record<Role, SyncAction[]> = {
  owner: ['read', 'sync', 'write', 'invite', 'revoke', 'change_role', 'delete_group'],
  admin: ['read', 'sync', 'write', 'invite', 'revoke', 'change_role'],
  editor: ['read', 'sync', 'write'],
  reader: ['read', 'sync'],
};

describe('ROLE_PERMISSIONS — full matrix (4 roles × 7 actions)', () => {
  for (const role of ROLES) {
    for (const action of ACTIONS) {
      const expected = EXPECTED_MATRIX[role].includes(action);
      it(`${role} can${expected ? '' : 'not'} ${action}`, () => {
        expect(ROLE_PERMISSIONS[role].has(action)).toBe(expected);
      });
    }
  }
});

describe('can() — basic permissions', () => {
  it('owner can delete_group', () => expect(can('owner', 'delete_group')).toBe(true));
  it('admin cannot delete_group', () => expect(can('admin', 'delete_group')).toBe(false));
  it('editor cannot invite', () => expect(can('editor', 'invite')).toBe(false));
  it('reader cannot write', () => expect(can('reader', 'write')).toBe(false));
  it('reader can read', () => expect(can('reader', 'read')).toBe(true));
  it('reader can sync', () => expect(can('reader', 'sync')).toBe(true));
});

describe('can() — owner-target exceptions', () => {
  it('owner can revoke owner (self)', () => {
    expect(can('owner', 'revoke', 'owner')).toBe(true);
  });
  it('owner can change_role of owner', () => {
    expect(can('owner', 'change_role', 'owner')).toBe(true);
  });
  it('admin cannot revoke owner', () => {
    expect(can('admin', 'revoke', 'owner')).toBe(false);
  });
  it('admin cannot change_role of owner', () => {
    expect(can('admin', 'change_role', 'owner')).toBe(false);
  });
  it('admin can revoke non-owner', () => {
    expect(can('admin', 'revoke', 'editor')).toBe(true);
    expect(can('admin', 'revoke', 'reader')).toBe(true);
    expect(can('admin', 'revoke', 'admin')).toBe(true);
  });
  it('admin can change_role of non-owner', () => {
    expect(can('admin', 'change_role', 'editor')).toBe(true);
    expect(can('admin', 'change_role', 'admin')).toBe(true);
  });
  it('editor cannot revoke even without owner target', () => {
    expect(can('editor', 'revoke', 'reader')).toBe(false);
  });
});
