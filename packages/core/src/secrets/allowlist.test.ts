import { describe, expect, it } from 'vitest';
import type { ClockPort } from '../ports/clock.js';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { isSyncable } from '../vault-sync/sync-filter.js';
import { addSecretAllowEntry, isSecretAllowed, readSecretAllowlist } from './allowlist.js';

const VAULT = '/vault';

function makeClock(iso = '2026-10-29T12:00:00Z'): ClockPort {
  return {
    now: () => new Date(iso),
    today: () => iso.slice(0, 10),
    sleep: () => Promise.resolve(),
  };
}

describe('readSecretAllowlist', () => {
  it('returns the empty allowlist when the file is absent', async () => {
    const fs = new MemoryFilesystem();
    const allowlist = await readSecretAllowlist(fs, VAULT);
    expect(allowlist).toEqual({ version: 1, entries: [] });
  });

  it('returns the empty allowlist when the file is invalid JSON', async () => {
    const fs = new MemoryFilesystem({
      [`${VAULT}/.chamba-sync/secret-allowlist.json`]: 'not json',
    });
    const allowlist = await readSecretAllowlist(fs, VAULT);
    expect(allowlist).toEqual({ version: 1, entries: [] });
  });
});

describe('addSecretAllowEntry / isSecretAllowed', () => {
  it('exempts the exact (path, fingerprint) pair', async () => {
    const fs = new MemoryFilesystem();
    const clock = makeClock();
    await addSecretAllowEntry(fs, clock, VAULT, { path: 'x.md', fingerprint: 'abc123def456' });
    const allowlist = await readSecretAllowlist(fs, VAULT);
    expect(isSecretAllowed(allowlist, 'x.md', 'abc123def456')).toBe(true);
  });

  it('does NOT exempt the same fingerprint at a different path', async () => {
    const fs = new MemoryFilesystem();
    const clock = makeClock();
    await addSecretAllowEntry(fs, clock, VAULT, { path: 'x.md', fingerprint: 'abc123def456' });
    const allowlist = await readSecretAllowlist(fs, VAULT);
    expect(isSecretAllowed(allowlist, 'y.md', 'abc123def456')).toBe(false);
  });

  it('does NOT exempt a different fingerprint at the same path', async () => {
    const fs = new MemoryFilesystem();
    const clock = makeClock();
    await addSecretAllowEntry(fs, clock, VAULT, { path: 'x.md', fingerprint: 'abc123def456' });
    const allowlist = await readSecretAllowlist(fs, VAULT);
    expect(isSecretAllowed(allowlist, 'x.md', '000000000000')).toBe(false);
  });

  it('calling twice does not duplicate the entry', async () => {
    const fs = new MemoryFilesystem();
    const clock = makeClock();
    await addSecretAllowEntry(fs, clock, VAULT, { path: 'x.md', fingerprint: 'abc123def456' });
    await addSecretAllowEntry(fs, clock, VAULT, { path: 'x.md', fingerprint: 'abc123def456' });
    const allowlist = await readSecretAllowlist(fs, VAULT);
    expect(allowlist.entries).toHaveLength(1);
  });

  it('the allowlist file lives under .chamba-sync/, which is never syncable', async () => {
    const fs = new MemoryFilesystem();
    const clock = makeClock();
    await addSecretAllowEntry(fs, clock, VAULT, { path: 'x.md', fingerprint: 'abc123def456' });
    expect(await fs.exists(`${VAULT}/.chamba-sync/secret-allowlist.json`)).toBe(true);
    expect(isSyncable('.chamba-sync/secret-allowlist.json')).toBe(false);
  });
});
