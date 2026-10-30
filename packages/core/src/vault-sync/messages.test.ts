/**
 * messages.test.ts — PARCHE-011 tests for vault-sync/messages.ts helpers.
 *
 * Every exported helper must start with 'npx @chamba/mcp vault'.
 * VaultDirMissingError and AdoptionPendingError messages must also contain it.
 */

import { describe, expect, it } from 'vitest';
import {
  joinFirstHint,
  joinInRepoHint,
  linkDirPlaceholderHint,
  linkHint,
  syncManualHint,
  unlinkWorkspaceHint,
  VAULT_CLI,
} from './messages.js';
import { AdoptionPendingError, VaultDirMissingError } from './runner.js';

const PREFIX = 'npx @chamba/mcp vault';

describe('VAULT_CLI constant', () => {
  it('equals "npx @chamba/mcp vault"', () => {
    expect(VAULT_CLI).toBe('npx @chamba/mcp vault');
  });
});

describe('message helpers — all start with npx @chamba/mcp vault', () => {
  it('linkHint starts with prefix', () => {
    expect(linkHint('team-alpha', '/home/user/vault')).toMatch(new RegExp(`^${PREFIX} `));
  });

  it('linkHint with --yes contains --yes flag', () => {
    const hint = linkHint('team-alpha', '/home/user/vault', { yes: true });
    expect(hint).toContain('--yes');
    expect(hint).toMatch(new RegExp(`^${PREFIX} `));
  });

  it('linkDirPlaceholderHint starts with prefix', () => {
    expect(linkDirPlaceholderHint('team-alpha')).toMatch(new RegExp(`^${PREFIX} `));
  });

  it('syncManualHint starts with prefix', () => {
    expect(syncManualHint()).toMatch(new RegExp(`^${PREFIX} `));
  });

  it('joinInRepoHint starts with prefix', () => {
    expect(joinInRepoHint('/path/to/repo')).toMatch(new RegExp(`^${PREFIX} `));
  });

  it('unlinkWorkspaceHint starts with prefix', () => {
    expect(unlinkWorkspaceHint()).toMatch(new RegExp(`^${PREFIX} `));
  });

  it('joinFirstHint starts with prefix', () => {
    expect(joinFirstHint()).toMatch(new RegExp(`^${PREFIX} `));
  });
});

describe('VaultDirMissingError message', () => {
  it('contains npx @chamba/mcp vault', () => {
    const err = new VaultDirMissingError('/some/vault', 'team-alpha');
    expect(err.message).toContain('npx @chamba/mcp vault');
  });

  it('contains the slug', () => {
    const err = new VaultDirMissingError('/some/vault', 'team-alpha');
    expect(err.message).toContain('team-alpha');
  });
});

describe('AdoptionPendingError message', () => {
  it('contains npx @chamba/mcp vault', () => {
    const err = new AdoptionPendingError('/some/vault', 'team-alpha');
    expect(err.message).toContain('npx @chamba/mcp vault');
  });

  it('contains the slug', () => {
    const err = new AdoptionPendingError('/some/vault', 'team-alpha');
    expect(err.message).toContain('team-alpha');
  });
});
