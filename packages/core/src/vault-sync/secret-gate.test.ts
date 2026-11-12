import { describe, expect, it, vi } from 'vitest';
import type { SecretAllowlist } from '../secrets/allowlist.js';
import { addSecretAllowEntry } from '../secrets/allowlist.js';
import { FakeHash } from '../testing/fake-hash.js';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import type { PushEntry } from './plan.js';
import type { PrecomputedFileFindings } from './secret-gate.js';
import {
  allowDigestOf,
  computeBlockedSecretMap,
  computeServerBlockedMap,
  screenPushEntries,
} from './secret-gate.js';

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

  it('a real PNG (binary, not UTF-8) always passes through — CHAMBA-023 D-Q3', async () => {
    const hash = new FakeHash();
    const fs = new MemoryFilesystem();
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0xff, 0xfe, 0xfd, 0xfc,
    ]);
    await fs.writeBytes(`${VAULT}/diagram.png`, png);
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

  it('a .pdf whose bytes happen to be plain UTF-8 text IS scanned (content, not extension) — CHAMBA-023 D-Q3', async () => {
    const hash = new FakeHash();
    const fs = new MemoryFilesystem({
      [`${VAULT}/notes.pdf`]: `token: ${'pch_'}${'A'.repeat(24)}\n`,
    });
    const entries: PushEntry[] = [{ path: 'notes.pdf', newHash: 'h1', baseHash: null }];
    const { allowed, blocked } = await screenPushEntries(
      { fs, hash },
      VAULT,
      entries,
      EMPTY_ALLOWLIST,
    );
    expect(allowed).toEqual([]);
    expect(blocked.map((f) => f.path)).toEqual(['notes.pdf']);

    // Eximible con allow-secret como cualquier otro hallazgo
    const finding = blocked[0];
    const allowlist = await addSecretAllowEntry(fs, clock(), VAULT, {
      path: 'notes.pdf',
      fingerprint: finding?.fingerprint ?? '',
    });
    const second = await screenPushEntries({ fs, hash }, VAULT, entries, allowlist);
    expect(second.allowed).toEqual(entries);
    expect(second.blocked).toEqual([]);
    expect(second.allowFingerprintsByHash.get('h1')).toEqual([finding?.fingerprint]);
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

  it('S3.1 — one file with 2 exempted findings: allowFingerprintsByHash has both under its hash', async () => {
    const hash = new FakeHash();
    const body = `token: ${'pch_'}${'A'.repeat(24)}\napi_key = sk_live_${'B'.repeat(30)}\n`;
    const fs = new MemoryFilesystem({ [`${VAULT}/two.md`]: body });
    const entries: PushEntry[] = [{ path: 'two.md', newHash: 'hAB', baseHash: null }];
    const { blocked: firstBlocked } = await screenPushEntries(
      { fs, hash },
      VAULT,
      entries,
      EMPTY_ALLOWLIST,
    );
    expect(firstBlocked.length).toBeGreaterThanOrEqual(2);

    let allowlist = EMPTY_ALLOWLIST;
    for (const f of firstBlocked) {
      allowlist = await addSecretAllowEntry(fs, clock(), VAULT, {
        path: 'two.md',
        fingerprint: f.fingerprint,
      });
    }
    const { allowed, allowFingerprintsByHash } = await screenPushEntries(
      { fs, hash },
      VAULT,
      entries,
      allowlist,
    );
    expect(allowed.map((e) => e.path)).toEqual(['two.md']);
    const fps = allowFingerprintsByHash.get('hAB');
    expect(fps).toBeDefined();
    expect(new Set(fps)).toEqual(new Set(firstBlocked.map((f) => f.fingerprint)));
  });

  it('S3.2 — one exempted + one non-exempted finding: entry is blocked, no map entry', async () => {
    const hash = new FakeHash();
    const body = `token: ${'pch_'}${'A'.repeat(24)}\napi_key = sk_live_${'B'.repeat(30)}\n`;
    const fs = new MemoryFilesystem({ [`${VAULT}/two.md`]: body });
    const entries: PushEntry[] = [{ path: 'two.md', newHash: 'hAB', baseHash: null }];
    const { blocked: firstBlocked } = await screenPushEntries(
      { fs, hash },
      VAULT,
      entries,
      EMPTY_ALLOWLIST,
    );
    const onlyFirst = firstBlocked[0];
    const allowlist = await addSecretAllowEntry(fs, clock(), VAULT, {
      path: 'two.md',
      fingerprint: onlyFirst?.fingerprint ?? '',
    });
    const { allowed, blocked, allowFingerprintsByHash } = await screenPushEntries(
      { fs, hash },
      VAULT,
      entries,
      allowlist,
    );
    expect(allowed).toEqual([]);
    expect(blocked.length).toBeGreaterThan(0);
    expect(allowFingerprintsByHash.has('hAB')).toBe(false);
  });

  it('S3.3 — a file with no findings contributes nothing to the map', async () => {
    const hash = new FakeHash();
    const fs = new MemoryFilesystem({ [`${VAULT}/clean.md`]: '# fine\n' });
    const entries: PushEntry[] = [{ path: 'clean.md', newHash: 'hclean', baseHash: null }];
    const { allowed, allowFingerprintsByHash } = await screenPushEntries(
      { fs, hash },
      VAULT,
      entries,
      EMPTY_ALLOWLIST,
    );
    expect(allowed).toEqual(entries);
    expect(allowFingerprintsByHash.size).toBe(0);
  });

  it('S3.4 — two paths with identical content (same hash), both exempted: one map entry, no duplicate fingerprints', async () => {
    const hash = new FakeHash();
    const body = `token: ${'pch_'}${'A'.repeat(24)}\n`;
    const fs = new MemoryFilesystem({
      [`${VAULT}/a.md`]: body,
      [`${VAULT}/b.md`]: body,
    });
    const entries: PushEntry[] = [{ path: 'a.md', newHash: 'shared', baseHash: null }];
    const { blocked: firstBlocked } = await screenPushEntries(
      { fs, hash },
      VAULT,
      entries,
      EMPTY_ALLOWLIST,
    );
    const finding = firstBlocked[0];
    await addSecretAllowEntry(fs, clock(), VAULT, {
      path: 'a.md',
      fingerprint: finding?.fingerprint ?? '',
    });
    const allowlist = await addSecretAllowEntry(fs, clock(), VAULT, {
      path: 'b.md',
      fingerprint: finding?.fingerprint ?? '',
    });
    const bothEntries: PushEntry[] = [
      { path: 'a.md', newHash: 'shared', baseHash: null },
      { path: 'b.md', newHash: 'shared', baseHash: null },
    ];
    const { allowed, allowFingerprintsByHash } = await screenPushEntries(
      { fs, hash },
      VAULT,
      bothEntries,
      allowlist,
    );
    expect(allowed.map((e) => e.path).sort()).toEqual(['a.md', 'b.md']);
    expect(allowFingerprintsByHash.size).toBe(1);
    expect(allowFingerprintsByHash.get('shared')).toEqual([finding?.fingerprint]);
  });

  it('S3.5 — a tombstone and a non-scannable binary contribute nothing to the map', async () => {
    const hash = new FakeHash();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]);
    const fs = new MemoryFilesystem();
    await fs.writeBytes(`${VAULT}/img.png`, png);
    const entries: PushEntry[] = [
      { path: 'gone.md', newHash: null, baseHash: 'old' },
      { path: 'img.png', newHash: 'hpng', baseHash: null },
    ];
    const { allowFingerprintsByHash } = await screenPushEntries(
      { fs, hash },
      VAULT,
      entries,
      EMPTY_ALLOWLIST,
    );
    expect(allowFingerprintsByHash.size).toBe(0);
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

  // ── CHAMBA-023 D-Q3: precomputed findings (from scanLocal) short-circuit the read ──

  describe('precomputed (from scanLocal) — avoids re-reading the file', () => {
    it('a hash match uses the precomputed findings and never calls fs.readBytes for that path', async () => {
      const hash = new FakeHash();
      const fs = new MemoryFilesystem({
        [`${VAULT}/secret.md`]: `token: ${'pch_'}${'A'.repeat(24)}\n`,
      });
      const readBytesSpy = vi.spyOn(fs, 'readBytes');
      const entries: PushEntry[] = [{ path: 'secret.md', newHash: 'h1', baseHash: null }];
      const precomputed = new Map<string, PrecomputedFileFindings>([
        [
          'secret.md',
          {
            hash: 'h1',
            findings: [{ path: 'secret.md', line: 1, kind: 'parche-token', fingerprint: 'fp1' }],
            scanned: true,
          },
        ],
      ]);
      const { blocked } = await screenPushEntries(
        { fs, hash },
        VAULT,
        entries,
        EMPTY_ALLOWLIST,
        undefined,
        precomputed,
      );
      expect(blocked.map((f) => f.fingerprint)).toEqual(['fp1']);
      expect(readBytesSpy).not.toHaveBeenCalled();
    });

    it('a hash match with scanned:false (binary) passes through without reading the file', async () => {
      const hash = new FakeHash();
      const fs = new MemoryFilesystem();
      await fs.writeBytes(`${VAULT}/img.png`, new Uint8Array([1, 2, 3]));
      const readBytesSpy = vi.spyOn(fs, 'readBytes');
      const entries: PushEntry[] = [{ path: 'img.png', newHash: 'h1', baseHash: null }];
      const precomputed = new Map<string, PrecomputedFileFindings>([
        ['img.png', { hash: 'h1', findings: [], scanned: false }],
      ]);
      const { allowed, blocked } = await screenPushEntries(
        { fs, hash },
        VAULT,
        entries,
        EMPTY_ALLOWLIST,
        undefined,
        precomputed,
      );
      expect(allowed).toEqual(entries);
      expect(blocked).toEqual([]);
      expect(readBytesSpy).not.toHaveBeenCalled();
    });

    it('a MISSING precomputed entry (e.g. a phase-3 copy scanLocal did not walk) falls back to reading the file', async () => {
      const hash = new FakeHash();
      const fs = new MemoryFilesystem({
        [`${VAULT}/copy.md`]: `token: ${'pch_'}${'A'.repeat(24)}\n`,
      });
      const readBytesSpy = vi.spyOn(fs, 'readBytes');
      const entries: PushEntry[] = [{ path: 'copy.md', newHash: 'h1', baseHash: null }];
      const { blocked } = await screenPushEntries(
        { fs, hash },
        VAULT,
        entries,
        EMPTY_ALLOWLIST,
        undefined,
        new Map(), // empty precomputed — no entry for copy.md
      );
      expect(blocked.map((f) => f.path)).toEqual(['copy.md']);
      expect(readBytesSpy).toHaveBeenCalledTimes(1);
    });

    it('a precomputed entry with a STALE hash (content changed again) falls back to reading the file', async () => {
      const hash = new FakeHash();
      const fs = new MemoryFilesystem({ [`${VAULT}/note.md`]: '# fine now\n' });
      const readBytesSpy = vi.spyOn(fs, 'readBytes');
      const entries: PushEntry[] = [{ path: 'note.md', newHash: 'h-current', baseHash: null }];
      const precomputed = new Map<string, PrecomputedFileFindings>([
        [
          'note.md',
          {
            hash: 'h-stale',
            findings: [{ path: 'note.md', line: 1, kind: 'jwt', fingerprint: 'stale-fp' }],
            scanned: true,
          },
        ],
      ]);
      const { allowed, blocked } = await screenPushEntries(
        { fs, hash },
        VAULT,
        entries,
        EMPTY_ALLOWLIST,
        undefined,
        precomputed,
      );
      // The stale finding must NOT be used — the file is re-read and found clean.
      expect(allowed).toEqual(entries);
      expect(blocked).toEqual([]);
      expect(readBytesSpy).toHaveBeenCalledTimes(1);
    });
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

describe('computeServerBlockedMap (CHAMBA-023 S5/B3 — server-side rejections)', () => {
  const now = '2026-10-29T12:00:00Z';

  it('registers a path rejected by the server', () => {
    const entries: PushEntry[] = [{ path: 'c.md', newHash: 'h1', baseHash: null }];
    const serverBlocked = [{ path: 'c.md', hash: 'h1', kinds: ['assignment'], allowDigest: '' }];
    const result = computeServerBlockedMap(undefined, entries, serverBlocked, now);
    expect(result).toEqual({
      'c.md': { kinds: ['assignment'], hash: 'h1', allowDigest: '', detectedAt: now },
    });
  });

  it('clears an entry once the server accepts it (no longer in serverBlocked)', () => {
    const base = {
      'c.md': { kinds: ['assignment'], hash: 'h1', allowDigest: '', detectedAt: now },
    };
    const entries: PushEntry[] = [{ path: 'c.md', newHash: 'h2', baseHash: 'h1' }];
    const result = computeServerBlockedMap(base, entries, [], now);
    expect(result).toEqual({});
  });

  it('preserves an entry for a path not evaluated this pass', () => {
    const base = {
      'c.md': { kinds: ['assignment'], hash: 'h1', allowDigest: '', detectedAt: now },
    };
    const result = computeServerBlockedMap(base, [], [], now);
    expect(result).toEqual(base);
  });

  // ── Review item 7: detectedAt is only "fresh" when hash OR allowDigest actually changed ──

  it('item 7 — hash AND allowDigest both unchanged: kinds may update, but detectedAt is PRESERVED (still the same ongoing block)', () => {
    const base = {
      'c.md': {
        kinds: ['assignment'],
        hash: 'h1',
        allowDigest: 'fp1',
        detectedAt: '2026-01-01T00:00:00Z',
      },
    };
    const entries: PushEntry[] = [{ path: 'c.md', newHash: 'h1', baseHash: null }];
    const serverBlocked = [
      { path: 'c.md', hash: 'h1', kinds: ['assignment', 'stripe-secret-key'], allowDigest: 'fp1' },
    ];
    const result = computeServerBlockedMap(base, entries, serverBlocked, now);
    expect(result).toEqual({
      'c.md': {
        kinds: ['assignment', 'stripe-secret-key'],
        hash: 'h1',
        allowDigest: 'fp1',
        detectedAt: '2026-01-01T00:00:00Z', // preserved, NOT `now`
      },
    });
  });

  it('item 7 / B3 — the allowDigest changed (same hash): detectedAt becomes fresh (a genuinely new rejection)', () => {
    const base = {
      'c.md': {
        kinds: ['assignment'],
        hash: 'h1',
        allowDigest: '', // nothing was exempted before
        detectedAt: '2026-01-01T00:00:00Z',
      },
    };
    const entries: PushEntry[] = [{ path: 'c.md', newHash: 'h1', baseHash: null }];
    // Same hash, but this time something WAS exempted and sent — the server
    // still rejected it, but under a different allowDigest than last time.
    const serverBlocked = [{ path: 'c.md', hash: 'h1', kinds: ['assignment'], allowDigest: 'fp1' }];
    const result = computeServerBlockedMap(base, entries, serverBlocked, now);
    expect(result).toEqual({
      'c.md': { kinds: ['assignment'], hash: 'h1', allowDigest: 'fp1', detectedAt: now },
    });
  });

  it('the hash changed: detectedAt becomes fresh (a genuinely new rejection)', () => {
    const base = {
      'c.md': {
        kinds: ['assignment'],
        hash: 'h1',
        allowDigest: '',
        detectedAt: '2026-01-01T00:00:00Z',
      },
    };
    const entries: PushEntry[] = [{ path: 'c.md', newHash: 'h2', baseHash: 'h1' }];
    const serverBlocked = [{ path: 'c.md', hash: 'h2', kinds: ['assignment'], allowDigest: '' }];
    const result = computeServerBlockedMap(base, entries, serverBlocked, now);
    expect(result).toEqual({
      'c.md': { kinds: ['assignment'], hash: 'h2', allowDigest: '', detectedAt: now },
    });
  });

  it('a brand-new rejection (no base entry at all) always gets a fresh detectedAt', () => {
    const entries: PushEntry[] = [{ path: 'c.md', newHash: 'h1', baseHash: null }];
    const serverBlocked = [{ path: 'c.md', hash: 'h1', kinds: ['assignment'], allowDigest: 'fp1' }];
    const result = computeServerBlockedMap(undefined, entries, serverBlocked, now);
    expect(result['c.md']?.detectedAt).toBe(now);
  });
});

describe('allowDigestOf (CHAMBA-023 B3)', () => {
  it('returns "" for undefined (no fingerprints for this hash)', () => {
    expect(allowDigestOf(undefined)).toBe('');
  });

  it('returns "" for an empty array', () => {
    expect(allowDigestOf([])).toBe('');
  });

  it('is deterministic regardless of input order (sorted before joining)', () => {
    expect(allowDigestOf(['bbb', 'aaa', 'ccc'])).toBe('aaa,bbb,ccc');
    expect(allowDigestOf(['ccc', 'bbb', 'aaa'])).toBe('aaa,bbb,ccc');
  });

  it('a single fingerprint has no trailing/leading comma', () => {
    expect(allowDigestOf(['abc123def456'])).toBe('abc123def456');
  });

  it('never includes anything but the fingerprints themselves — no values possible by construction', () => {
    const digest = allowDigestOf(['a1b2c3d4e5f6', '001122334455']);
    expect(digest).toBe('001122334455,a1b2c3d4e5f6');
  });
});
