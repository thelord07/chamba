import { describe, expect, it } from 'vitest';
import {
  changesResponseSchema,
  deviceAuthPollResponseSchema,
  deviceAuthStartResponseSchema,
  deviceSchema,
  groupSchema,
  hashSchema,
  joinRequestSchema,
  joinResponseSchema,
  PROTOCOL_VERSION,
  pushRequestSchema,
  pushResponseSchema,
  roleSchema,
  userSchema,
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

  it('addendum: rejects a.md twice even when one entry is a delete', () => {
    expect(() =>
      pushRequestSchema.parse({
        protocol: 1,
        changes: [
          { path: 'a.md', baseHash: 'a'.repeat(64), newHash: null },
          { path: 'a.md', baseHash: null, newHash: 'b'.repeat(64) },
        ],
      }),
    ).toThrow();
  });

  it('addendum: accepts a casing rename (delete Nota.md + live nota.md)', () => {
    const parsed = pushRequestSchema.parse({
      protocol: 1,
      changes: [
        { path: 'Nota.md', baseHash: 'a'.repeat(64), newHash: null },
        { path: 'nota.md', baseHash: null, newHash: 'a'.repeat(64) },
      ],
    });
    expect(parsed.changes.map((c) => c.path)).toEqual(['Nota.md', 'nota.md']);
  });

  it('addendum: accepts two deletes that share a pathKey', () => {
    expect(() =>
      pushRequestSchema.parse({
        protocol: 1,
        changes: [
          { path: 'Nota.md', baseHash: 'a'.repeat(64), newHash: null },
          { path: 'nota.md', baseHash: 'b'.repeat(64), newHash: null },
        ],
      }),
    ).not.toThrow();
  });

  it('AC2 + addendum: rejects two live entries sharing a pathKey (Nota.md→H1 + nota.md→H2)', () => {
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

describe('joinRequestSchema — code', () => {
  const validBase = { name: 'Joys', email: 'joys@example.com' };

  it('normalizes lowercase to uppercase', () => {
    const result = joinRequestSchema.parse({ ...validBase, code: 'k7qx-m2rp' });
    expect(result.code).toBe('K7QX-M2RP');
  });

  it('trims whitespace then normalizes', () => {
    const result = joinRequestSchema.parse({ ...validBase, code: '  k7qx-m2rp  ' });
    expect(result.code).toBe('K7QX-M2RP');
  });

  it('rejects code without dash', () => {
    expect(() => joinRequestSchema.parse({ ...validBase, code: 'K7QXM2RP' })).toThrow();
  });

  it('rejects code with wrong format', () => {
    expect(() => joinRequestSchema.parse({ ...validBase, code: 'K7QX-M2R' })).toThrow();
  });

  it('accepts valid uppercase code', () => {
    const result = joinRequestSchema.parse({ ...validBase, code: 'K7QX-M2RP' });
    expect(result.code).toBe('K7QX-M2RP');
  });
});

describe('joinResponseSchema', () => {
  const validUserDevice = {
    user: { id: 'u1', name: 'Joys' },
    device: { id: 'd1', label: 'MacBook' },
  };

  it('accepts valid response with admin role', () => {
    expect(() =>
      joinResponseSchema.parse({
        group: { id: '1', slug: 'mi-vault', name: 'Mi Vault' },
        role: 'admin',
        deviceToken: 'tok123',
        ...validUserDevice,
      }),
    ).not.toThrow();
  });

  it('no unexpected fields stripped (strip by default)', () => {
    const result = joinResponseSchema.parse({
      group: { id: '1', slug: 'x', name: 'X' },
      role: 'editor',
      deviceToken: 'tok',
      ...validUserDevice,
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
      user: { id: 'u1', name: 'Joys' },
      device: { id: 'd1', label: 'MacBook' },
    });
    expect(result).toMatchObject({ status: 'approved', role: 'admin' });
  });

  it('approved response has no extra secret fields', () => {
    const result = deviceAuthPollResponseSchema.parse({
      status: 'approved',
      deviceToken: 'tok',
      group: { id: '1', slug: 's', name: 'N' },
      role: 'owner',
      user: { id: 'u1', name: 'N' },
      device: { id: 'd1', label: 'L' },
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

// ─── 002c AC2 — join request identity normalization ───────────────────────────

describe('joinRequestSchema — 002c AC2', () => {
  it('002c AC2: normalizes code to uppercase, trims name, lowercases email, deviceLabel undefined', () => {
    const result = joinRequestSchema.parse({
      code: 'k7qx-m2rp',
      name: ' Joys ',
      email: 'Joys@Lapzo.COM',
    });
    expect(result.code).toBe('K7QX-M2RP');
    expect(result.name).toBe('Joys');
    expect(result.email).toBe('joys@lapzo.com');
    expect(result.deviceLabel).toBeUndefined();
  });
});

// ─── 002c AC3 — join request field validation ─────────────────────────────────

describe('joinRequestSchema — 002c AC3', () => {
  const validBase = { code: 'K7QX-M2RP', name: 'Joys', email: 'joys@example.com' };

  // Four required-fail tests
  it('002c AC3: name empty string fails', () => {
    expect(() => joinRequestSchema.parse({ ...validBase, name: '' })).toThrow();
  });

  it('002c AC3: name 65 chars fails', () => {
    expect(() => joinRequestSchema.parse({ ...validBase, name: 'a'.repeat(65) })).toThrow();
  });

  it('002c AC3: email not-an-email fails', () => {
    expect(() => joinRequestSchema.parse({ ...validBase, email: 'not-an-email' })).toThrow();
  });

  it('002c AC3: deviceLabel with internal newline fails', () => {
    expect(() => joinRequestSchema.parse({ ...validBase, deviceLabel: 'Mac\nBook' })).toThrow();
  });

  // Pass cases
  it('002c AC3: name 64 chars passes', () => {
    const result = joinRequestSchema.parse({ ...validBase, name: 'a'.repeat(64) });
    expect(result.name).toBe('a'.repeat(64));
  });

  // Gate decision 1 — whitespace-only treated as empty
  it('002c AC3: name only spaces fails (gate decision 1)', () => {
    expect(() => joinRequestSchema.parse({ ...validBase, name: '   ' })).toThrow();
  });

  it('002c AC3: deviceLabel empty string fails (gate decision 1)', () => {
    expect(() => joinRequestSchema.parse({ ...validBase, deviceLabel: '' })).toThrow();
  });

  it('002c AC3: deviceLabel only spaces fails (gate decision 1)', () => {
    expect(() => joinRequestSchema.parse({ ...validBase, deviceLabel: '   ' })).toThrow();
  });

  // Gate decision 2 — trailing newline trimmed, internal newline rejected
  it('002c AC3: deviceLabel trailing newline is trimmed to Mac (gate decision 2)', () => {
    const result = joinRequestSchema.parse({ ...validBase, deviceLabel: 'Mac\n' });
    expect(result.deviceLabel).toBe('Mac');
  });

  it('002c AC3: name with trailing newline is trimmed (gate decision 2)', () => {
    const result = joinRequestSchema.parse({ ...validBase, name: ' Joys\n' });
    expect(result.name).toBe('Joys');
  });

  // Email normalization
  it('002c AC3: email with uppercase and spaces is normalized', () => {
    const result = joinRequestSchema.parse({ ...validBase, email: '  Joys@Lapzo.COM  ' });
    expect(result.email).toBe('joys@lapzo.com');
  });

  it('002c AC3: email of 255 chars after normalization fails', () => {
    // 249 local + @ + b.com(5) = 255 chars — exceeds the 254-char limit
    const longEmail = `${'a'.repeat(249)}@b.com`;
    expect(longEmail.length).toBe(255);
    expect(() => joinRequestSchema.parse({ ...validBase, email: longEmail })).toThrow();
  });
});

// ─── 002c AC4 — join response with user and device ───────────────────────────

describe('joinResponseSchema — 002c AC4', () => {
  const validGroup = { id: 'g1', slug: 'my-vault', name: 'My Vault' };
  const validUser = { id: 'u1', name: 'Joys' };
  const validDevice = { id: 'd1', label: 'MacBook' };

  it('002c AC4: joinResponseSchema without user fails', () => {
    expect(() =>
      joinResponseSchema.parse({
        group: validGroup,
        role: 'editor',
        deviceToken: 'tok',
        device: validDevice,
      }),
    ).toThrow();
  });

  it('002c AC4: joinResponseSchema without device fails', () => {
    expect(() =>
      joinResponseSchema.parse({
        group: validGroup,
        role: 'editor',
        deviceToken: 'tok',
        user: validUser,
      }),
    ).toThrow();
  });

  it('002c AC4: joinResponseSchema complete passes', () => {
    expect(() =>
      joinResponseSchema.parse({
        group: validGroup,
        role: 'editor',
        deviceToken: 'tok',
        user: validUser,
        device: validDevice,
      }),
    ).not.toThrow();
  });

  it('002c AC4: user {id:""} fails', () => {
    expect(() =>
      joinResponseSchema.parse({
        group: validGroup,
        role: 'editor',
        deviceToken: 'tok',
        user: { id: '', name: 'Joys' },
        device: validDevice,
      }),
    ).toThrow();
  });
});

// ─── 002c Gate decision 3 — approved poll requires user + device ──────────────

describe('deviceAuthPollResponseSchema — 002c gate decision 3', () => {
  const validGroup = { id: 'g1', slug: 's', name: 'N' };
  const validUser = { id: 'u1', name: 'Joys' };
  const validDevice = { id: 'd1', label: 'MacBook' };

  it('002c gate3: approved without user fails', () => {
    expect(() =>
      deviceAuthPollResponseSchema.parse({
        status: 'approved',
        deviceToken: 'tok',
        group: validGroup,
        role: 'owner',
        device: validDevice,
      }),
    ).toThrow();
  });

  it('002c gate3: approved without device fails', () => {
    expect(() =>
      deviceAuthPollResponseSchema.parse({
        status: 'approved',
        deviceToken: 'tok',
        group: validGroup,
        role: 'owner',
        user: validUser,
      }),
    ).toThrow();
  });

  it('002c gate3: approved complete passes', () => {
    expect(() =>
      deviceAuthPollResponseSchema.parse({
        status: 'approved',
        deviceToken: 'tok',
        group: validGroup,
        role: 'owner',
        user: validUser,
        device: validDevice,
      }),
    ).not.toThrow();
  });

  it('002c gate3: non-approved statuses unaffected (pending still passes)', () => {
    expect(() => deviceAuthPollResponseSchema.parse({ status: 'pending' })).not.toThrow();
  });

  it('002c gate3: non-approved statuses unaffected (denied still passes)', () => {
    expect(() => deviceAuthPollResponseSchema.parse({ status: 'denied' })).not.toThrow();
  });
});

// ─── 002c Key-set — schema shape and no secret fields ────────────────────────

describe('userSchema — 002c key-set', () => {
  it('002c key-set: userSchema parsed keys are exactly [id, name]', () => {
    const result = userSchema.parse({ id: 'u1', name: 'Joys', extra: 'stripped' });
    expect(new Set(Object.keys(result))).toEqual(new Set(['id', 'name']));
  });
});

describe('deviceSchema — 002c key-set', () => {
  it('002c key-set: deviceSchema parsed keys are exactly [id, label]', () => {
    const result = deviceSchema.parse({ id: 'd1', label: 'MacBook', extra: 'stripped' });
    expect(new Set(Object.keys(result))).toEqual(new Set(['id', 'label']));
  });
});

describe('joinResponseSchema — 002c key-set no secrets', () => {
  it('002c key-set: join response has no credential-like keys besides deviceToken', () => {
    const result = joinResponseSchema.parse({
      group: { id: 'g1', slug: 's', name: 'N' },
      role: 'owner',
      deviceToken: 'tok',
      user: { id: 'u1', name: 'Joys' },
      device: { id: 'd1', label: 'MacBook' },
      password: 'leaked',
      secret: 'leaked',
      apiKey: 'leaked',
      token: 'leaked',
    });
    const keys = Object.keys(result);
    const forbidden = ['password', 'secret', 'apiKey', 'token'];
    for (const k of forbidden) {
      expect(keys).not.toContain(k);
    }
    expect(keys).toContain('deviceToken');
  });
});

describe('deviceAuthPollResponseSchema — 002c key-set approved no secrets', () => {
  it('002c key-set: approved poll has no credential-like keys besides deviceToken', () => {
    const result = deviceAuthPollResponseSchema.parse({
      status: 'approved',
      deviceToken: 'tok',
      group: { id: 'g1', slug: 's', name: 'N' },
      role: 'owner',
      user: { id: 'u1', name: 'N' },
      device: { id: 'd1', label: 'L' },
      password: 'leaked',
      secret: 'leaked',
      apiKey: 'leaked',
    }) as { status: 'approved' };
    const keys = Object.keys(result);
    const forbidden = ['password', 'secret', 'apiKey'];
    for (const k of forbidden) {
      expect(keys).not.toContain(k);
    }
    expect(keys).toContain('deviceToken');
  });
});
