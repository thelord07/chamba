import { describe, expect, it } from 'vitest';
import {
  changesResponseSchema,
  deviceAuthPollResponseSchema,
  deviceAuthStartResponseSchema,
  groupSchema,
  hashSchema,
  joinRequestSchema,
  joinResponseSchema,
  PROTOCOL_VERSION,
  pushRequestSchema,
  pushResponseSchema,
  roleSchema,
  vaultPathSchema,
} from './protocol.js';

describe('PROTOCOL_VERSION', () => {
  it('is 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('hashSchema', () => {
  it('accepts a valid sha256 hex string', () => {
    const h = 'a'.repeat(64);
    expect(hashSchema.parse(h)).toBe(h);
  });
  it('rejects wrong length', () => {
    expect(() => hashSchema.parse('a'.repeat(63))).toThrow();
  });
  it('rejects uppercase', () => {
    expect(() => hashSchema.parse('A'.repeat(64))).toThrow();
  });
});

describe('vaultPathSchema — AC3', () => {
  it('rejects empty string', () => {
    expect(() => vaultPathSchema.parse('')).toThrow();
  });
  it('rejects path starting with /', () => {
    expect(() => vaultPathSchema.parse('/x.md')).toThrow();
  });
  it('rejects path with double slash (empty segment)', () => {
    expect(() => vaultPathSchema.parse('a//b.md')).toThrow();
  });
  it('rejects path with backslash', () => {
    expect(() => vaultPathSchema.parse('a\\b.md')).toThrow();
  });
  it('rejects path with . segment', () => {
    expect(() => vaultPathSchema.parse('a/./b.md')).toThrow();
  });
  it('rejects path with .. segment', () => {
    expect(() => vaultPathSchema.parse('../x.md')).toThrow();
  });
  it('rejects segment starting with .chamba-sync (lowercase)', () => {
    expect(() => vaultPathSchema.parse('.chamba-sync/state.json')).toThrow();
  });

  it('AC4: rejects .Chamba-Sync/state.md (mixed-case variant)', () => {
    expect(() => vaultPathSchema.parse('.Chamba-Sync/state.md')).toThrow();
  });

  it('AC4: rejects notas/.CHAMBA-SYNC (all-caps variant)', () => {
    expect(() => vaultPathSchema.parse('notas/.CHAMBA-SYNC')).toThrow();
  });
  it('rejects path with 513 chars', () => {
    expect(() => vaultPathSchema.parse('a'.repeat(513))).toThrow();
  });
  it('rejects path with null char (\\u0000)', () => {
    expect(() => vaultPathSchema.parse('a\u0000b.md')).toThrow();
  });
  it('accepts NFD path and normalizes to NFC', () => {
    // NFD: "día" decomposed
    const nfd = 'notas/día 1.md'; // i + combining acute
    const nfc = 'notas/día 1.md'; // í precomposed
    const result = vaultPathSchema.parse(nfd);
    // The two literals are genuinely distinct code unit sequences
    expect(nfd).not.toBe(nfc);
    // Output must equal the NFC form AND differ from the NFD input
    expect(result).toBe(nfc);
    expect(result).not.toBe(nfd);
  });
  it('accepts a normal path', () => {
    expect(vaultPathSchema.parse('a/b/c.md')).toBe('a/b/c.md');
  });
  it('accepts exactly 512 chars', () => {
    const p = `${'a'.repeat(511)}.`;
    expect(() => vaultPathSchema.parse(p)).not.toThrow();
  });
});

describe('roleSchema', () => {
  it('accepts all 4 roles', () => {
    for (const r of ['owner', 'admin', 'editor', 'reader'] as const) {
      expect(roleSchema.parse(r)).toBe(r);
    }
  });
  it('rejects unknown role', () => {
    expect(() => roleSchema.parse('lector')).toThrow();
  });
});

describe('pushRequestSchema — AC4', () => {
  const validChange = {
    path: 'a.md',
    baseHash: null,
    newHash: 'a'.repeat(64),
  };

  it('rejects 0 items', () => {
    expect(() => pushRequestSchema.parse({ protocol: 1, changes: [] })).toThrow();
  });

  it('rejects 501 items', () => {
    const changes = Array.from({ length: 501 }, (_, i) => ({
      ...validChange,
      path: `file${i}.md`,
    }));
    expect(() => pushRequestSchema.parse({ protocol: 1, changes })).toThrow();
  });

  it('rejects duplicate paths (same NFC)', () => {
    expect(() =>
      pushRequestSchema.parse({
        protocol: 1,
        changes: [validChange, { ...validChange, baseHash: null }],
      }),
    ).toThrow();
  });

  it('AC2: rejects case-insensitive duplicate paths (Nota.md + nota.md)', () => {
    expect(() =>
      pushRequestSchema.parse({
        protocol: 1,
        changes: [
          { path: 'Nota.md', baseHash: null, newHash: 'a'.repeat(64) },
          { path: 'nota.md', baseHash: null, newHash: 'b'.repeat(64) },
        ],
      }),
    ).toThrow();
  });

  it('rejects NFD-vs-NFC duplicate paths (AC4 / NFD dup push)', () => {
    const nfd = 'día.md';
    const nfc = 'día.md';
    expect(() =>
      pushRequestSchema.parse({
        protocol: 1,
        changes: [
          { path: nfd, baseHash: null, newHash: 'a'.repeat(64) },
          { path: nfc, baseHash: null, newHash: 'b'.repeat(64) },
        ],
      }),
    ).toThrow();
  });

  it('accepts exactly 1 item', () => {
    expect(() => pushRequestSchema.parse({ protocol: 1, changes: [validChange] })).not.toThrow();
  });

  it('accepts exactly 500 items', () => {
    const changes = Array.from({ length: 500 }, (_, i) => ({
      ...validChange,
      path: `file${i}.md`,
    }));
    expect(() => pushRequestSchema.parse({ protocol: 1, changes })).not.toThrow();
  });
});

describe('joinRequestSchema — AC5', () => {
  it('normalizes lowercase to uppercase', () => {
    const result = joinRequestSchema.parse({ code: 'k7qx-m2rp' });
    expect(result.code).toBe('K7QX-M2RP');
  });

  it('trims whitespace then normalizes', () => {
    const result = joinRequestSchema.parse({ code: '  k7qx-m2rp  ' });
    expect(result.code).toBe('K7QX-M2RP');
  });

  it('rejects code without dash', () => {
    expect(() => joinRequestSchema.parse({ code: 'K7QXM2RP' })).toThrow();
  });

  it('rejects code with wrong format', () => {
    expect(() => joinRequestSchema.parse({ code: 'K7QX-M2R' })).toThrow();
  });

  it('accepts valid uppercase code', () => {
    const result = joinRequestSchema.parse({ code: 'K7QX-M2RP' });
    expect(result.code).toBe('K7QX-M2RP');
  });
});

describe('joinResponseSchema', () => {
  it('accepts valid response with admin role', () => {
    expect(() =>
      joinResponseSchema.parse({
        group: { id: '1', slug: 'mi-vault', name: 'Mi Vault' },
        role: 'admin',
        deviceToken: 'tok123',
      }),
    ).not.toThrow();
  });

  it('no unexpected fields stripped (strip by default)', () => {
    const result = joinResponseSchema.parse({
      group: { id: '1', slug: 'x', name: 'X' },
      role: 'editor',
      deviceToken: 'tok',
      secretPassword: 'leaked', // should be stripped
    });
    expect(Object.keys(result)).not.toContain('secretPassword');
  });
});

describe('changesResponseSchema', () => {
  it('accepts valid response', () => {
    expect(() =>
      changesResponseSchema.parse({
        protocol: 1,
        changes: [],
        cursor: 0,
        hasMore: false,
      }),
    ).not.toThrow();
  });
});

describe('pushResponseSchema', () => {
  it('accepts ok and conflict results', () => {
    expect(() =>
      pushResponseSchema.parse({
        results: [
          { status: 'ok', path: 'a.md', seq: 1 },
          { status: 'conflict', path: 'b.md', currentHash: null },
        ],
      }),
    ).not.toThrow();
  });
});

describe('deviceAuthStartResponseSchema', () => {
  it('accepts valid response', () => {
    expect(() =>
      deviceAuthStartResponseSchema.parse({
        deviceCode: 'dev123',
        userCode: 'USR-001',
        verificationUrl: 'https://example.com/verify',
        interval: 5,
        expiresIn: 1800,
      }),
    ).not.toThrow();
  });
});

describe('deviceAuthPollResponseSchema', () => {
  it('accepts pending status', () => {
    expect(deviceAuthPollResponseSchema.parse({ status: 'pending' })).toMatchObject({
      status: 'pending',
    });
  });

  it('accepts approved status with admin role', () => {
    const result = deviceAuthPollResponseSchema.parse({
      status: 'approved',
      deviceToken: 'tok456',
      group: { id: '2', slug: 'g2', name: 'G2' },
      role: 'admin',
    });
    expect(result).toMatchObject({ status: 'approved', role: 'admin' });
  });

  it('approved response has no extra secret fields', () => {
    const result = deviceAuthPollResponseSchema.parse({
      status: 'approved',
      deviceToken: 'tok',
      group: { id: '1', slug: 's', name: 'N' },
      role: 'owner',
      apiKey: 'shouldbestripped', // extra
    }) as { status: 'approved' };
    expect(Object.keys(result)).not.toContain('apiKey');
  });
});

describe('groupSchema', () => {
  it('has exactly id, slug, name keys', () => {
    const g = groupSchema.parse({ id: '1', slug: 'x', name: 'X', extra: 'y' });
    expect(new Set(Object.keys(g))).toEqual(new Set(['id', 'slug', 'name']));
  });
});
