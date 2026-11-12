import { describe, expect, it } from 'vitest';
import type { SecretAllowlist } from '../secrets/allowlist.js';
import { addSecretAllowEntry } from '../secrets/allowlist.js';
import { FakeHash } from '../testing/fake-hash.js';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import type { PushEntry } from './plan.js';
import { computeBlockedSecretMap, screenPushEntries } from './secret-gate.js';

const VAULT = '/vault';
const EMPTY_ALLOWLIST: SecretAllowlist = { version: 1, entries: [] };

function clock(iso = '2026-10-29T12:00:00Z') {
  return {
    now: () => new Date(iso),
    today: () => iso.slice(0, 10),
    sleep: () => Promise.resolve(),
  };
}

describe('screenPushEntries', () => {
  it('excludes a file with an un-allowlisted secret, allows the rest', async () => {
    const hash = new FakeHash();
    const fs = new MemoryFilesystem({
      [`${VAULT}/clean.md`]: '# fine\n',
      [`${VAULT}/secret.md`]: `token: ${'pch_'}${'A'.repeat(24)}\n`,
    });
    const entries: PushEntry[] = [
      { path: 'clean.md', newHash: 'h1', baseHash: null },
      { path: 'secret.md', newHash: 'h2', baseHash: null },
    ];
    const { allowed, blocked } = await screenPushEntries(
      { fs, hash },
      VAULT,
      entries,
      EMPTY_ALLOWLIST,
    );
    expect(allowed.map((e) => e.path)).toEqual(['clean.md']);
    expect(blocked.map((f) => f.path)).toEqual(['secret.md']);
  });

  it('tombstones (newHash === null) always pass through', async () => {
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const entries: PushEntry[] = [{ path: 'gone.md', newHash: null, baseHash: 'old' }];
    const { allowed, blocked } = await screenPushEntries(
      { fs, hash },
      VAULT,
      entries,
      EMPTY_ALLOWLIST,
    );
    expect(allowed).toEqual(entries);
    expect(blocked).toEqual([]);
  });

  it('non-scannable extensions always pass through', async () => {
    const hash = new FakeHash();
    const fs = new MemoryFilesystem({ [`${VAULT}/diagram.png`]: 'not-really-a-png' });
    const entries: PushEntry[] = [{ path: 'diagram.png', newHash: 'h1', baseHash: null }];
    const { allowed, blocked } = await screenPushEntries(
      { fs, hash },
      VAULT,
      entries,
      EMPTY_ALLOWLIST,
    );
    expect(allowed).toEqual(entries);
    expect(blocked).toEqual([]);
  });

  it('an allowlisted fingerprint at the right path passes through unmodified', async () => {
    const hash = new FakeHash();
    const fs = new MemoryFilesystem({
      [`${VAULT}/secret.md`]: `token: ${'pch_'}${'A'.repeat(24)}\n`,
    });
    const entries: PushEntry[] = [{ path: 'secret.md', newHash: 'h2', baseHash: null }];
    const { blocked: firstBlocked } = await screenPushEntries(
      { fs, hash },
      VAULT,
      entries,
      EMPTY_ALLOWLIST,
    );
    const finding = firstBlocked[0];
    expect(finding).toBeDefined();
    const allowlist = await addSecretAllowEntry(fs, clock(), VAULT, {
      path: 'secret.md',
      fingerprint: finding?.fingerprint ?? '',
    });
    const { allowed, blocked } = await screenPushEntries({ fs, hash }, VAULT, entries, allowlist);
    expect(allowed.map((e) => e.path)).toEqual(['secret.md']);
    expect(blocked).toEqual([]);
  });

  it('allowlist entry does not exempt the same fingerprint at a different path', async () => {
    const hash = new FakeHash();
    const body = `token: ${'pch_'}${'A'.repeat(24)}\n`;
    const fs = new MemoryFilesystem({
      [`${VAULT}/a.md`]: body,
      [`${VAULT}/b.md`]: body,
    });
    const entries: PushEntry[] = [{ path: 'a.md', newHash: 'h1', baseHash: null }];
    const { blocked: firstBlocked } = await screenPushEntries(
      { fs, hash },
      VAULT,
      entries,
      EMPTY_ALLOWLIST,
    );
    const finding = firstBlocked[0];
    const allowlist = await addSecretAllowEntry(fs, clock(), VAULT, {
      path: 'a.md',
      fingerprint: finding?.fingerprint ?? '',
    });
    const entriesB: PushEntry[] = [{ path: 'b.md', newHash: 'h2', baseHash: null }];
    const { blocked } = await screenPushEntries({ fs, hash }, VAULT, entriesB, allowlist);
    expect(blocked.map((f) => f.path)).toEqual(['b.md']);
  });
});

describe('computeBlockedSecretMap', () => {
  const now = '2026-10-29T12:00:00Z';

  it('adds a path with a new finding', () => {
    const entries: PushEntry[] = [{ path: 'a.md', newHash: 'h', baseHash: null }];
    const blocked = [{ path: 'a.md', line: 1, kind: 'assignment' as const, fingerprint: 'f1' }];
    const result = computeBlockedSecretMap(undefined, entries, blocked, now);
    expect(result).toEqual({
      'a.md': { findings: [{ fingerprint: 'f1', kind: 'assignment', line: 1 }], detectedAt: now },
    });
  });

  it('keeps EVERY finding for a path with more than one distinct secret', () => {
    const entries: PushEntry[] = [{ path: 'a.md', newHash: 'h', baseHash: null }];
    const blocked = [
      { path: 'a.md', line: 1, kind: 'assignment' as const, fingerprint: 'f1' },
      { path: 'a.md', line: 5, kind: 'parche-token' as const, fingerprint: 'f2' },
    ];
    const result = computeBlockedSecretMap(undefined, entries, blocked, now);
    expect(result['a.md']?.findings).toEqual([
      { fingerprint: 'f1', kind: 'assignment', line: 1 },
      { fingerprint: 'f2', kind: 'parche-token', line: 5 },
    ]);
  });

  it('removes a path that was re-evaluated and is no longer blocked', () => {
    const base = {
      'a.md': { findings: [{ fingerprint: 'f1', kind: 'assignment', line: 1 }], detectedAt: now },
    };
    const entries: PushEntry[] = [{ path: 'a.md', newHash: 'h2', baseHash: 'h' }];
    const result = computeBlockedSecretMap(base, entries, [], now);
    expect(result).toEqual({});
  });

  it('keeps a path not evaluated this pass untouched', () => {
    const base = {
      'a.md': { findings: [{ fingerprint: 'f1', kind: 'assignment', line: 1 }], detectedAt: now },
    };
    const result = computeBlockedSecretMap(base, [], [], now);
    expect(result).toEqual(base);
  });
});
