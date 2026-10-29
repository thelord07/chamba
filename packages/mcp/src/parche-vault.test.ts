/**
 * parche-vault.test.ts — Tests for PARCHE-004 Phase 2 behaviour in packages/mcp.
 *
 * Covers:
 *   AC2  — vault join creates vault, stores credential at 0600, token never leaks
 *   AC3  — server resolved from link; http://evil.com rejected; http://localhost allowed
 *   CLI  — 404/409/429 messages; no-TTY exit; --label ""; default label = hostname
 *   Join on existing vault (gate 1) — no file disappears, conflicts become copies
 *   vault sync & parche status — multi-vault sync, status fields, token absent
 *   AC12 — vault leave removes credential, files intact
 *   Mutex — two concurrent chamba_vault_sync calls serialise on the same vault
 */

import { FakeHash, FakeParche, MemoryFilesystem } from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { runVaultCli, type VaultCliDeps } from './cli/vault.js';
import { createServer } from './server.js';
import type { Services } from './services.js';

const silentLogger = pino({ level: 'silent' });

const FAKE_NOW = '2026-06-09T10:00:00.000Z';

function makeClock(now = FAKE_NOW) {
  const d = new Date(now);
  return {
    now: () => d,
    today: () => d.toISOString().slice(0, 10),
  };
}

function makeParche() {
  const parche = new FakeParche(makeClock());
  const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
  parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });
  return { parche, group };
}

function makeServices(parche: FakeParche, extra: Partial<Services> = {}): Services {
  return {
    fs: new MemoryFilesystem(),
    process: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    clock: makeClock(),
    system: {
      resources: () => ({
        totalMemBytes: 16 * 1024 ** 3,
        freeMemBytes: 8 * 1024 ** 3,
        cpus: 8,
        loadAvg1: 0,
      }),
    },
    cwd: '/proj',
    homedir: '/home/test',
    http: parche,
    hash: new FakeHash(),
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
    ...extra,
  };
}

async function connect(svc: Services) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer(silentLogger, svc);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.map((c) => c.text).join('\n');
}

function structuredOf(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent ?? {};
}

function makeCli(
  svc: Services,
  argv: string[],
  {
    isTTY = false,
    prompt = async () => '',
    hostname,
  }: { isTTY?: boolean; prompt?: (q: string) => Promise<string>; hostname?: string } = {},
): Promise<{ out: string[]; err: string[]; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  let code = 0;
  const deps: VaultCliDeps = {
    services: svc,
    stdout: (m) => out.push(m),
    stderr: (m) => err.push(m),
    exit: (c) => {
      code = c;
    },
    prompt,
    isTTY,
    hostname,
  };
  return runVaultCli(argv, deps).then(() => ({ out, err, code }));
}

// ─── AC2: vault join creates vault + credential + no token leak ───────────────

describe('AC2 — vault join', () => {
  it('creates ~/.chamba/vaults/<slug>/.obsidian/ after join', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);

    const r = await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);

    expect(r.code).toBe(0);
    expect(await svc.fs.exists('/home/test/.chamba/vaults/team-alpha/.obsidian')).toBe(true);
    // state.json must exist
    expect(
      await svc.fs.exists('/home/test/.chamba/vaults/team-alpha/.chamba-sync/state.json'),
    ).toBe(true);
  });

  it('stores credential at mode 0600 outside the vault', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);

    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);

    const credPath = '/home/test/.chamba/credentials.json';
    expect(await svc.fs.exists(credPath)).toBe(true);
    // Mode must be 0600 (MemoryFilesystem records it)
    const mode = (svc.fs as MemoryFilesystem).getMode(credPath);
    expect(mode).toBe(0o600);
    // Credential is NOT inside the vault directory
    expect(credPath.startsWith('/home/test/.chamba/vaults/')).toBe(false);
  });

  it('token is NOT present in CLI stdout or stderr', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);

    const r = await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);

    const allOutput = [...r.out, ...r.err].join('\n');
    expect(allOutput).not.toMatch(/pch_/);
    expect(allOutput).not.toMatch(/token/i);
  });

  it('token is NOT present in MCP tool result (text + structuredContent)', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_join',
      arguments: { code: 'K7QX-M2RP', name: 'Joys', email: 'j@x.dev' },
    });

    const txt = textOf(result);
    const sc = structuredOf(result);

    expect(txt).not.toMatch(/pch_/);
    expect(JSON.stringify(sc)).not.toMatch(/pch_/);
    // Also ensure the structured content doesn't have a token field
    expect(sc).not.toHaveProperty('token');
    expect(sc).not.toHaveProperty('deviceToken');

    await server.close();
  });

  it('token is NOT present in any vault file (state.json check)', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);

    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);

    // state.json must not contain the token
    const stateJson = await svc.fs.readFile(
      '/home/test/.chamba/vaults/team-alpha/.chamba-sync/state.json',
    );
    expect(stateJson).not.toMatch(/pch_fake_/);
    // credential file must be outside the vault
    const credPath = '/home/test/.chamba/credentials.json';
    expect(credPath.startsWith('/home/test/.chamba/vaults/')).toBe(false);
    // credential itself contains the token (expected), but not in vault path
    const credContent = await svc.fs.readFile(credPath);
    expect(credContent).toMatch(/pch_fake_/); // token is in credentials.json (correct)
    // Nothing inside the vault dir mentions the token
    const vaultDir = '/home/test/.chamba/vaults/team-alpha';
    // We can check specific known vault files
    const knownFiles = [`${vaultDir}/.chamba-sync/state.json`];
    for (const f of knownFiles) {
      if (await svc.fs.exists(f)) {
        const content = await svc.fs.readFile(f);
        expect(content).not.toMatch(/pch_fake_/);
      }
    }
  });

  it('token is NOT present in pino log output (redact) — real logger, captured stream', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);

    // Build a real logger with the same redact config as createLogger(),
    // but writing to an in-process captured array.
    const logLines: string[] = [];
    const capturedLogger = pino(
      {
        level: 'debug',
        redact: [
          'token',
          'deviceToken',
          '*.token',
          'headers.authorization',
          'req.headers.authorization',
        ],
      },
      { write: (line: string) => logLines.push(line) },
    );

    // Wire the captured logger into the server (createServer takes logger as first arg)
    const [ct, st] = (
      await import('@modelcontextprotocol/sdk/inMemory.js')
    ).InMemoryTransport.createLinkedPair();
    const { createServer: cs } = await import('./server.js');
    const srv = cs(capturedLogger, svc);
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const client2 = new Client({ name: 'test-redact', version: '0.0.0' });
    await Promise.all([srv.connect(st), client2.connect(ct)]);

    await client2.callTool({
      name: 'chamba_vault_join',
      arguments: { code: 'K7QX-M2RP', name: 'Joys', email: 'j@x.dev' },
    });

    // Retrieve the token from the credential file (it IS stored there — correct)
    const credContent = await svc.fs.readFile('/home/test/.chamba/credentials.json');
    const cred = JSON.parse(credContent) as Record<string, { token: string }>;
    const entry = Object.values(cred)[0];
    if (!entry) throw new Error('no credential entry found');
    const token = entry.token;
    expect(token).toMatch(/^pch_/);

    // The server logged at least one line (vault-join.ts logs on success)
    expect(logLines.length).toBeGreaterThan(0);

    // No log line must contain the raw token value
    for (const line of logLines) {
      expect(line).not.toContain(token);
    }

    // Also verify that the pino redact config actually works:
    // log an object with sensitive fields and confirm they are redacted
    capturedLogger.info(
      { token, deviceToken: token, headers: { authorization: `Bearer ${token}` } },
      'redact-check',
    );
    const redactLine = logLines[logLines.length - 1];
    expect(redactLine).toBeDefined();
    expect(redactLine).not.toContain(token);
    expect(redactLine).toContain('[Redacted]');

    await srv.close();
  });
});

// ─── AC3: server resolution + http rejection ──────────────────────────────────

describe('AC3 — server URL resolution', () => {
  it('https link extracts code and server', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const svc = makeServices(parche, {
      parcheServerUrl: 'https://parche.chamba.tools',
    });

    // Using the link form — server comes from the link
    const r = await makeCli(svc, [
      'join',
      'https://parche.chamba.tools/j/K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
    ]);

    expect(r.code).toBe(0);
    expect(r.out.join('\n')).toContain('team-alpha');
  });

  it('http://evil.com link is rejected with non-zero exit', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);

    const r = await makeCli(svc, [
      'join',
      'http://evil.com/j/K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
    ]);

    expect(r.code).not.toBe(0);
    expect(r.err.join('\n')).toMatch(/http/i);
  });

  it('http://localhost:8787 is allowed', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'local-group', name: 'Local' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });
    const svc = makeServices(parche);

    const r = await makeCli(svc, [
      'join',
      'http://localhost:8787/j/K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
    ]);

    // Should not fail due to http:// validation (localhost is allowed)
    expect(r.err.join('\n')).not.toMatch(/not allowed|rejected|must use https/i);
  });
});

// ─── CLI error messages and flags ────────────────────────────────────────────

describe('CLI error messages', () => {
  it('404 → "código inválido, vencido o agotado"', async () => {
    const parche = new FakeParche(makeClock());
    // No invite seeded → 404
    const svc = makeServices(parche);

    const r = await makeCli(svc, ['join', 'XXXX-YYYY', '--name', 'Joys', '--email', 'j@x.dev']);

    expect(r.code).not.toBe(0);
    expect(r.err.join('\n')).toContain('código inválido, vencido o agotado');
  });

  it('409 → "ya eres miembro: usa `vault login`"', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);

    // Join once to become a member
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);

    // Use the same parche but join again with same email → 409 (already_member)
    parche.addInvite({
      code: 'K7QX-M2RQ',
      groupId: [
        ...(parche as FakeParche & { groups: Map<string, { id: string }> }).groups.values(),
      ][0].id,
      role: 'editor',
    });

    const r2 = await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);
    // Second join with same email → 409
    expect(r2.code).not.toBe(0);
    expect(r2.err.join('\n')).toContain('ya eres miembro');
  });

  it('429 → "demasiados intentos, espera un minuto" with non-zero exit', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });
    parche.rateLimitJoin = true;
    const svc = makeServices(parche);

    const r = await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);

    expect(r.code).not.toBe(0);
    expect(r.err.join('\n')).toContain('demasiados intentos, espera un minuto');
  });

  it('no TTY and no --name/--email → non-zero exit', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);

    const r = await makeCli(svc, ['join', 'K7QX-M2RP'], { isTTY: false });

    expect(r.code).not.toBe(0);
    expect(r.err.join('\n')).toContain('--name');
  });

  it('default label (no --label) sends hostname to server', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });
    const svc = makeServices(parche);
    const FAKE_HOST = 'mi-laptop-test';

    // Inject hostname so the test is deterministic (does not call node:os)
    const r = await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev'], {
      hostname: FAKE_HOST,
    });

    expect(r.code).toBe(0);
    // FakeParche captures the last join request body
    expect(parche.lastJoinRequest).not.toBeNull();
    expect(parche.lastJoinRequest?.deviceLabel).toBe(FAKE_HOST);
  });

  it('--label "" → deviceLabel omitted from request', async () => {
    // We need to check that FakeParche receives no deviceLabel when --label ""
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });
    const svc = makeServices(parche);

    const r = await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--label',
      '',
    ]);

    // Should succeed (empty label → omit from request, not error)
    expect(r.code).toBe(0);
    // Device in FakeParche should have default label (no deviceLabel sent)
    const credContent = await svc.fs.readFile('/home/test/.chamba/credentials.json');
    const cred = JSON.parse(credContent);
    const entry = Object.values(cred)[0] as { device: { label: string } };
    // When deviceLabel is omitted, FakeParche uses 'device' as default
    expect(entry.device.label).toBe('device');
  });
});

// ─── Rejoin (gate 1): existing vault with old state.json ─────────────────────

describe('Gate 1 — rejoin with existing vault', () => {
  it('no local file disappears after rejoin', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    // Pre-create vault with an old state.json (cursor=200) and some local files
    const fs = new MemoryFilesystem();
    const vaultDir = '/home/test/.chamba/vaults/team-alpha';
    const stateJson = JSON.stringify({
      server: 'https://parche.chamba.tools',
      slug: 'team-alpha',
      cursor: 200,
      files: { 'local-only.md': { syncedHash: null } },
      lastSyncAt: '2026-01-01T00:00:00.000Z',
    });
    await fs.mkdir(`${vaultDir}/.obsidian`);
    await fs.mkdir(`${vaultDir}/.chamba-sync`);
    await fs.writeFile(`${vaultDir}/.chamba-sync/state.json`, stateJson);
    await fs.writeFile(`${vaultDir}/local-only.md`, '# Local File\n');
    await fs.writeFile(`${vaultDir}/shared.md`, '# Shared (local version)\n');

    const svc = makeServices(parche, { fs });

    const r = await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);

    expect(r.code).toBe(0);
    // local-only.md must still exist
    expect(await fs.exists(`${vaultDir}/local-only.md`)).toBe(true);
    expect(await fs.exists(`${vaultDir}/shared.md`)).toBe(true);
  });

  it("ignores the stale state.json: differing file becomes a conflict, cursor is the server's", async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    // Remote already has shared.md (seq 1), written by another member.
    const remoteBytes = new TextEncoder().encode('# Shared (remote version)\n');
    const remoteHash = await new FakeHash().sha256(remoteBytes);
    parche.seedBlob(group.id, remoteHash, remoteBytes);
    const remoteChange = parche.seedChange(group.id, {
      path: 'shared.md',
      hash: remoteHash,
      author: 'Ana',
      device: 'ana-laptop',
      at: '2026-10-29T10:00:00Z',
    });

    // Existing folder with a stale state.json (cursor 200) and a different local shared.md.
    const fs = new MemoryFilesystem();
    const vaultDir = '/home/test/.chamba/vaults/team-alpha';
    await fs.mkdir(`${vaultDir}/.obsidian`);
    await fs.mkdir(`${vaultDir}/.chamba-sync`);
    await fs.writeFile(
      `${vaultDir}/.chamba-sync/state.json`,
      JSON.stringify({
        server: 'https://parche.chamba.tools',
        slug: 'team-alpha',
        cursor: 200,
        files: { 'shared.md': { syncedHash: remoteHash } },
        lastSyncAt: '2026-01-01T00:00:00.000Z',
      }),
    );
    await fs.writeFile(`${vaultDir}/shared.md`, '# Shared (local version)\n');

    const svc = makeServices(parche, { fs });
    const r = await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);
    expect(r.code).toBe(0);

    // Had the stale state been trusted (synced = remote), the local edit would have been
    // pushed over the remote. Instead it is adopted: remote at shared.md, local in a copy.
    expect(await fs.readFile(`${vaultDir}/shared.md`)).toBe('# Shared (remote version)\n');
    const copy = await fs.readFile(`${vaultDir}/shared (conflicto joys).md`);
    expect(copy).toContain('# Shared (local version)');

    const state = JSON.parse(await fs.readFile(`${vaultDir}/.chamba-sync/state.json`));
    expect(state.groupId).toBe(group.id);
    expect(state.cursor).toBe(remoteChange.seq);
  });
});

// ─── vault sync and parche status ────────────────────────────────────────────

describe('vault sync', () => {
  it('syncs all vaults when no slug is given', async () => {
    const parche1 = new FakeParche(makeClock());
    const g1 = parche1.seedGroup({ slug: 'vault-one', name: 'Vault One' });
    parche1.addInvite({ code: 'AAAA-BBBB', groupId: g1.id });

    const svc1 = makeServices(parche1);
    // Join vault-one
    await makeCli(svc1, ['join', 'AAAA-BBBB', '--name', 'Joys', '--email', 'j@x.dev']);

    // Now add a second group to the same parche (different invite)
    const g2 = parche1.seedGroup({ slug: 'vault-two', name: 'Vault Two' });
    parche1.addInvite({ code: 'CCCC-DDDD', groupId: g2.id });
    // Join vault-two with same services (same credentials store)
    await makeCli(svc1, ['join', 'CCCC-DDDD', '--name', 'Joys', '--email', 'j@x.dev']);

    // Now sync without slug — should sync both
    const r = await makeCli(svc1, ['sync']);
    const allOut = r.out.join('\n');
    expect(allOut).toContain('vault-one');
    expect(allOut).toContain('vault-two');
  });

  it('tool chamba_vault_sync syncs a specific vault', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const svc = makeServices(parche);
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);

    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_sync',
      arguments: { slug: 'team-alpha' },
    });

    expect(textOf(result)).toContain('team-alpha');
    expect(textOf(result)).not.toMatch(/pch_/);

    await server.close();
  });
});

describe('parche status', () => {
  it('shows server, slug, role, last sync, pending, path', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);

    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);

    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_parche_status',
      arguments: {},
    });

    const txt = textOf(result);
    expect(txt).toContain('team-alpha');
    expect(txt).toContain('server:');
    expect(txt).toContain('role:');
    expect(txt).toContain('last sync:');
    expect(txt).toContain('pending:');
    expect(txt).toContain('path:');

    // Token must NOT appear
    expect(txt).not.toMatch(/pch_/);
    expect(txt).not.toMatch(/token/i);

    await server.close();
  });

  it('structuredContent includes personalMemoryCount', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);

    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);

    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_parche_status',
      arguments: {},
    });

    const sc = structuredOf(result);
    expect(sc).toHaveProperty('personalMemoryCount');
    expect(typeof sc.personalMemoryCount).toBe('number');

    await server.close();
  });
});

// ─── AC12: vault leave ────────────────────────────────────────────────────────

describe('AC12 — vault leave', () => {
  it('removes credential but keeps vault files intact', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);

    // Join first
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);
    const vaultDir = '/home/test/.chamba/vaults/team-alpha';

    // Add a file to the vault
    await svc.fs.writeFile(`${vaultDir}/my-note.md`, '# Note\n');

    // Leave
    const r = await makeCli(svc, ['leave', 'team-alpha']);
    expect(r.code).toBe(0);

    // Vault files still there
    expect(await svc.fs.exists(`${vaultDir}/my-note.md`)).toBe(true);
    expect(await svc.fs.exists(`${vaultDir}/.obsidian`)).toBe(true);

    // Credential removed
    const credPath = '/home/test/.chamba/credentials.json';
    if (await svc.fs.exists(credPath)) {
      const credContent = await svc.fs.readFile(credPath);
      const creds = JSON.parse(credContent);
      // Should not have the team-alpha key
      const hasTeamAlpha = Object.keys(creds).some((k) => k.includes('team-alpha'));
      expect(hasTeamAlpha).toBe(false);
    }
  });

  it('prints the vault path on leave', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);

    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);

    const r = await makeCli(svc, ['leave', 'team-alpha']);
    expect(r.out.join('\n')).toContain('.chamba/vaults/team-alpha');
  });
});

// ─── Mutex: concurrent vault sync serialization ───────────────────────────────

describe('Mutex — concurrent vault sync serialization', () => {
  it('two concurrent chamba_vault_sync calls do not run syncOnce in parallel', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);

    // Join first
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);

    // Track maximum concurrent /changes requests to detect if syncOnce runs in parallel.
    // Each syncOnce issues at least one GET /changes, so concurrent syncs would show > 1.
    const originalRequest = parche.request.bind(parche);
    let activeChangesRequests = 0;
    let maxConcurrentChanges = 0;

    // Add a small artificial delay to make concurrent overlap detectable
    let resolveDelay: () => void = () => undefined;
    const delayPromise = new Promise<void>((r) => {
      resolveDelay = r;
    });

    parche.request = async (req) => {
      if (req.url.includes('/changes')) {
        activeChangesRequests++;
        if (activeChangesRequests > maxConcurrentChanges) {
          maxConcurrentChanges = activeChangesRequests;
        }
        // First call blocks until released; second call would be queued by mutex
        if (activeChangesRequests === 1) {
          await delayPromise;
        }
        const result = await originalRequest(req);
        activeChangesRequests--;
        return result;
      }
      return originalRequest(req);
    };

    const { client, server } = await connect(svc);

    // Start both calls but don't await yet
    const p1 = client.callTool({ name: 'chamba_vault_sync', arguments: { slug: 'team-alpha' } });
    const p2 = client.callTool({ name: 'chamba_vault_sync', arguments: { slug: 'team-alpha' } });

    // Give p1 time to acquire mutex and start /changes
    await new Promise((r) => setTimeout(r, 10));
    // Now release the delay so p1 can finish
    resolveDelay();

    const [r1, r2] = await Promise.all([p1, p2]);

    // Both should return results
    expect(textOf(r1)).toBeTruthy();
    expect(textOf(r2)).toBeTruthy();

    // Mutex serialization means at most 1 concurrent /changes call
    expect(maxConcurrentChanges).toBeLessThanOrEqual(1);

    await server.close();
  });
});
