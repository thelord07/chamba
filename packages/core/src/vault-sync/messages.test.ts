/**
 * messages.test.ts — PARCHE-011 tests for vault-sync/messages.ts helpers.
 *
 * Every exported helper must start with 'npx @chamba/mcp vault'.
 * VaultDirMissingError and AdoptionPendingError messages must also contain it.
 */

import { describe, expect, it } from 'vitest';
import type { Finding } from '../secrets/scanner.js';
import {
  allowSecretHint,
  blockedSecretMessage,
  blockedSecretsSummary,
  joinFirstHint,
  joinInRepoHint,
  linkDirPlaceholderHint,
  linkHint,
  REDACTED_PLACEHOLDER,
  syncManualHint,
  unlinkWorkspaceHint,
  VAULT_CLI,
  writeBlockedSecretMessage,
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

// ─── Secret-scanner messages (CHAMBA-021 S4) ─────────────────────────────────

function makeFinding(): Finding {
  // Derived from a value that starts with 'pch_TESTSECRET' — the test fixes
  // that neither the message helpers nor this test ever embed that value.
  return { path: 'informes/x.md', line: 42, kind: 'aws-access-key', fingerprint: 'a1b2c3d4e5f6' };
}

describe('allowSecretHint', () => {
  it('starts with the vault CLI prefix and quotes the path', () => {
    const hint = allowSecretHint('a1b2c3d4e5f6', 'informes/x.md');
    expect(hint).toMatch(new RegExp(`^${PREFIX} `));
    expect(hint).toBe('npx @chamba/mcp vault allow-secret a1b2c3d4e5f6 --path "informes/x.md"');
  });
});

describe('blockedSecretMessage', () => {
  it('matches the exact §2.2 format and never contains a secret value', () => {
    const msg = blockedSecretMessage(makeFinding());
    expect(msg).toBe(
      '⛔ bloqueado por posible secreto: informes/x.md:42 (aws-access-key). ' +
        'Quita el valor o márcalo como falso positivo con `npx @chamba/mcp vault allow-secret a1b2c3d4e5f6 --path "informes/x.md"`.',
    );
    expect(msg).not.toContain('TESTSECRET');
    expect(msg).not.toContain('pch_');
  });

  it('contains path, line, kind, and fingerprint', () => {
    const f = makeFinding();
    const msg = blockedSecretMessage(f);
    expect(msg).toContain(f.path);
    expect(msg).toContain(String(f.line));
    expect(msg).toContain(f.kind);
    expect(msg).toContain(f.fingerprint);
  });
});

describe('blockedSecretsSummary', () => {
  it('returns [] for no blocked findings', () => {
    expect(blockedSecretsSummary([])).toEqual([]);
  });

  it('caps detail lines at 10 and adds a "y N más" tail', () => {
    const many: Finding[] = Array.from({ length: 13 }, (_, i) => ({
      path: `n${i}.md`,
      line: 1,
      kind: 'assignment' as const,
      fingerprint: `${i}`.padStart(12, '0'),
    }));
    const lines = blockedSecretsSummary(many);
    expect(lines[0]).toContain('13 archivo(s)');
    expect(lines).toHaveLength(1 + 10 + 1);
    expect(lines.at(-1)).toBe('y 3 más');
  });
});

describe('writeBlockedSecretMessage (D-Q1)', () => {
  it('matches the exact owner-decided format and references <REDACTADO>', () => {
    const msg = writeBlockedSecretMessage({ field: 'title', line: 7, kind: 'openai-key' });
    expect(msg).toBe(
      '⛔ no se escribió la nota: posible secreto en title línea 7 (openai-key). ' +
        'Reemplaza el valor por <REDACTADO> y vuelve a intentarlo.',
    );
    expect(msg).toContain(REDACTED_PLACEHOLDER);
  });

  it('says "el contenido" for the content field', () => {
    const msg = writeBlockedSecretMessage({ field: 'content', line: 3, kind: 'jwt' });
    expect(msg).toContain('posible secreto en el contenido línea 3 (jwt)');
  });
});
