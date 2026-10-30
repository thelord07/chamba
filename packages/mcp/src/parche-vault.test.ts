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

import {
  CredentialsStore,
  FakeHash,
  FakeParche,
  MemoryFilesystem,
  readConflictMeta,
  readState,
} from '@chamba/core';
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
        ...(parche as unknown as { groups: Map<string, { id: string }> }).groups.values(),
      ][0]?.id as string,
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
  it('no local file disappears after rejoin (with --yes)', async () => {
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

    // D1: universal gate — pass --yes to confirm the upload
    const r = await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--yes',
    ]);

    expect(r.code).toBe(0);
    // local-only.md must still exist
    expect(await fs.exists(`${vaultDir}/local-only.md`)).toBe(true);
    expect(await fs.exists(`${vaultDir}/shared.md`)).toBe(true);
  });

  it('rejoin without --yes and no TTY: does not upload, exit 1', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const vaultDir = '/home/test/.chamba/vaults/team-alpha';
    await fs.mkdir(`${vaultDir}/.obsidian`);
    await fs.writeFile(`${vaultDir}/local-only.md`, '# Local File\n');

    const svc = makeServices(parche, { fs });

    // No --yes, no TTY: should exit 1 and NOT upload
    const requestsBefore = parche.requestLog.length;
    const r = await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev'], {
      isTTY: false,
    });

    expect(r.code).toBe(1);
    // FakeParche should have received the join request but no PUT (blob upload)
    const putRequests = parche.requestLog
      .slice(requestsBefore)
      .filter((req) => req.method === 'PUT');
    expect(putRequests.length).toBe(0);
    // stderr should mention --yes
    const errText = r.err.join('\n');
    expect(errText).toMatch(/--yes/);
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
    // D1: universal gate — pass --yes to confirm the upload
    const r = await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--yes',
    ]);
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

// ─── PARCHE-009: vault join --dir, adoption gate, pendingAdoption ─────────────

describe('PARCHE-009 AC2 — vault join --dir', () => {
  it('join --dir /custom creates cred with dir field and state.json in custom dir', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const svc = makeServices(parche);

    // With --yes to bypass gate (empty vault, so gate is a no-op anyway)
    const r = await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--dir',
      '/custom/vault',
      '--yes',
    ]);

    expect(r.code).toBe(0);
    // Credential should have dir field
    const credJson = await svc.fs.readFile('/home/test/.chamba/credentials.json');
    const creds = JSON.parse(credJson);
    const entry = Object.values(creds)[0] as { dir?: string };
    expect(entry.dir).toBe('/custom/vault');
    // State should be in custom dir
    expect(await svc.fs.exists('/custom/vault/.chamba-sync/state.json')).toBe(true);
  });

  it('join with default (no --dir) does NOT store dir in credential (AC3)', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const svc = makeServices(parche);
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);

    const credJson = await svc.fs.readFile('/home/test/.chamba/credentials.json');
    const creds = JSON.parse(credJson);
    const entry = Object.values(creds)[0] as { dir?: string };
    expect(entry.dir).toBeUndefined();
    // Default path used
    expect(
      await svc.fs.exists('/home/test/.chamba/vaults/team-alpha/.chamba-sync/state.json'),
    ).toBe(true);
  });
});

describe('PARCHE-009 AC4 — adoption gate', () => {
  it('join with existing 30 syncable files, no TTY, no --yes: exit 1, no push, mentions --yes', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    // Create vault with 30 .md files
    const fs = new MemoryFilesystem();
    const vaultDir = '/custom/vault';
    await fs.mkdir(`${vaultDir}/.obsidian`);
    for (let i = 1; i <= 30; i++) {
      await fs.writeFile(`${vaultDir}/note-${String(i).padStart(2, '0')}.md`, `# Note ${i}`);
    }

    const svc = makeServices(parche, { fs });
    const requestsBefore = parche.requestLog.length;

    const r = await makeCli(
      svc,
      ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--dir', vaultDir],
      { isTTY: false },
    );

    expect(r.code).toBe(1);
    // No PUT blobs uploaded
    const putRequests = parche.requestLog
      .slice(requestsBefore)
      .filter((req) => req.method === 'PUT');
    expect(putRequests.length).toBe(0);
    // Output mentions 30 files and --yes
    const allOutput = [...r.out, ...r.err].join('\n');
    expect(allOutput).toMatch(/30/);
    expect(allOutput).toMatch(/--yes/);
  });

  it('join with --yes and 30 files: uploads all 30', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const vaultDir = '/custom/vault';
    await fs.mkdir(`${vaultDir}/.obsidian`);
    for (let i = 1; i <= 30; i++) {
      await fs.writeFile(`${vaultDir}/note-${String(i).padStart(2, '0')}.md`, `# Note ${i}`);
    }

    const svc = makeServices(parche, { fs });
    const requestsBefore = parche.requestLog.length;

    const r = await makeCli(
      svc,
      ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--dir', vaultDir, '--yes'],
      { isTTY: false },
    );

    expect(r.code).toBe(0);
    // Should have uploaded blobs (PUT requests)
    const putRequests = parche.requestLog
      .slice(requestsBefore)
      .filter((req) => req.method === 'PUT');
    expect(putRequests.length).toBe(30);
  });
});

describe('PARCHE-009 R1 — pendingAdoption blocks vault sync', () => {
  it('vault sync exits 1 when vault is pendingAdoption, without pushing to FakeParche', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const vaultDir = '/home/test/.chamba/vaults/team-alpha';
    await fs.mkdir(`${vaultDir}/.obsidian`);
    await fs.writeFile(`${vaultDir}/note.md`, '# Note');

    const svc = makeServices(parche, { fs });

    // Join without --yes (leaves pendingAdoption=true)
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev'], {
      isTTY: false,
    });

    // Now try to sync — should fail
    const requestsBefore = parche.requestLog.length;
    const r = await makeCli(svc, ['sync']);

    expect(r.code).toBe(1);
    // No PUT uploads
    const putRequests = parche.requestLog
      .slice(requestsBefore)
      .filter((req) => req.method === 'PUT');
    expect(putRequests.length).toBe(0);
    const errText = r.err.join('\n');
    expect(errText).toMatch(/pendiente/i);
  });
});

describe('PARCHE-009 AC9 — vault link', () => {
  it('vault link resets state and syncs after confirming (--yes)', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    // First join (empty vault, so gate passes automatically)
    const r1 = await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);
    expect(r1.code).toBe(0);

    const oldVaultDir = '/home/test/.chamba/vaults/team-alpha';
    const newVaultDir = '/new/vault';

    // Create new vault dir with some files
    await fs.mkdir(newVaultDir);
    await fs.writeFile(`${newVaultDir}/note.md`, '# Note');

    // Link to new dir
    const r2 = await makeCli(svc, ['link', 'team-alpha', '--dir', newVaultDir, '--yes']);
    expect(r2.code).toBe(0);

    // New cred.dir should be set
    const credJson = await fs.readFile('/home/test/.chamba/credentials.json');
    const creds = JSON.parse(credJson);
    const entry = Object.values(creds)[0] as { dir?: string };
    expect(entry.dir).toBe(newVaultDir);

    // Old dir is intact
    expect(await fs.exists(oldVaultDir)).toBe(true);
  });
});

// ─── PARCHE-009 AC2 extended: status/sync/leave use custom dir ────────────────

describe('PARCHE-009 AC2 extended — status/sync/leave with custom dir', () => {
  it('vault status prints path: /custom/vault after join --dir', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });
    const vaultDir = '/custom/vault';
    const fs = new MemoryFilesystem();
    await fs.mkdir(vaultDir);
    const svc = makeServices(parche, { fs });

    await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--dir',
      vaultDir,
      '--yes',
    ]);

    const r = await makeCli(svc, ['status']);
    const allOut = r.out.join('\n');
    expect(allOut).toContain('path:');
    expect(allOut).toContain(vaultDir);
  });

  it('vault sync syncs files under custom dir', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });
    const vaultDir = '/custom/vault';
    const fs = new MemoryFilesystem();
    await fs.mkdir(vaultDir);
    await fs.writeFile(`${vaultDir}/note.md`, '# Test\n');
    const svc = makeServices(parche, { fs });

    await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--dir',
      vaultDir,
      '--yes',
    ]);

    // Add a new file and sync
    await fs.writeFile(`${vaultDir}/new-note.md`, '# New\n');
    const requestsBefore = parche.requestLog.length;
    const r = await makeCli(svc, ['sync']);
    expect(r.code).toBe(0);
    const putRequests = parche.requestLog
      .slice(requestsBefore)
      .filter((req) => req.method === 'PUT');
    expect(putRequests.length).toBe(1);
  });

  it('vault leave message includes custom vault dir path', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });
    const vaultDir = '/custom/vault';
    const fs = new MemoryFilesystem();
    await fs.mkdir(vaultDir);
    const svc = makeServices(parche, { fs });

    await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--dir',
      vaultDir,
      '--yes',
    ]);

    const r = await makeCli(svc, ['leave', 'team-alpha']);
    expect(r.code).toBe(0);
    const allOut = r.out.join('\n');
    expect(allOut).toContain(vaultDir);
    // Files stay intact
    expect(await fs.exists(vaultDir)).toBe(true);
  });
});

// ─── PARCHE-009 AC4 extended: sample paths, credential stays, pendingAdoption ─

describe('PARCHE-009 AC4 extended — sample paths listed, pendingAdoption persists', () => {
  it('no TTY, no --yes: output lists exactly 20 sample paths and pendingAdoption in state', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const vaultDir = '/custom/vault';
    await fs.mkdir(`${vaultDir}/.obsidian`);
    // Add ignored files too (D3): .obsidian/app.json, .trash/x.md, img.xyz
    await fs.writeFile(`${vaultDir}/.obsidian/app.json`, '{}');
    await fs.mkdir(`${vaultDir}/.trash`);
    await fs.writeFile(`${vaultDir}/.trash/x.md`, '# Trash');
    await fs.writeFile(`${vaultDir}/img.xyz`, 'binary');
    for (let i = 1; i <= 30; i++) {
      await fs.writeFile(`${vaultDir}/note-${String(i).padStart(2, '0')}.md`, `# Note ${i}`);
    }

    const svc = makeServices(parche, { fs });
    const r = await makeCli(
      svc,
      ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--dir', vaultDir],
      { isTTY: false },
    );

    expect(r.code).toBe(1);

    // Count exactly 20 sample paths in output (lines starting with '  - ')
    const allOut = [...r.out, ...r.err].join('\n');
    const sampleLines = allOut.split('\n').filter((l) => l.trim().startsWith('- '));
    expect(sampleLines.length).toBe(20);

    // Credential must still exist (not removed on decline)
    const creds = new CredentialsStore(fs, svc.homedir);
    const allSlugs = await creds.listSlugs();
    expect(allSlugs.length).toBe(1);

    // State must have pendingAdoption=true
    const state = await readState(fs, vaultDir);
    expect(state?.pendingAdoption).toBe(true);
  });
});

// ─── PARCHE-009 AC5 CLI: conflict during --dir adoption ─────────────────────

describe('PARCHE-009 AC5 CLI — conflict during join --dir --yes', () => {
  it('remote a.md wins, local goes to conflict copy, b.md uploaded', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    // Seed remote a.md=R (from another device)
    const hash = new FakeHash();
    const remoteContent = '# Remote Version\n';
    const remoteBytes = new TextEncoder().encode(remoteContent);
    const remoteHash = await hash.sha256(remoteBytes);
    parche.seedBlob(group.id, remoteHash, remoteBytes);
    parche.seedChange(group.id, {
      path: 'a.md',
      hash: remoteHash,
      author: 'Ana',
      device: 'ana-laptop',
      at: '2026-10-29T10:00:00Z',
    });

    // Local vault with a.md=L (different from remote) and b.md
    const fs = new MemoryFilesystem();
    const vaultDir = '/local/vault';
    await fs.mkdir(`${vaultDir}/.obsidian`);
    const localContent = '# Local Version\n';
    await fs.writeFile(`${vaultDir}/a.md`, localContent);
    await fs.writeFile(`${vaultDir}/b.md`, '# Note B\n');

    const svc = makeServices(parche, { fs, hash });
    const r = await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--dir',
      vaultDir,
      '--yes',
    ]);

    expect(r.code).toBe(0);

    // a.md must equal remote (R)
    expect(await fs.readFile(`${vaultDir}/a.md`)).toBe(remoteContent);

    // Conflict copy must exist with local content
    const entries = await fs.readDir(vaultDir);
    const conflictFile = entries.find((e) => e.name.includes('conflicto'));
    expect(conflictFile).toBeDefined();
    if (!conflictFile) throw new Error('conflict file not found');
    const conflictContent = await fs.readFile(`${vaultDir}/${conflictFile.name}`);
    expect(conflictContent).toContain('# Local Version');

    // Conflict frontmatter must be present
    const conflictMeta = readConflictMeta(conflictContent);
    expect(conflictMeta?.conflictOf).toBe('a.md');

    // b.md must still exist (not disappeared)
    expect(await fs.exists(`${vaultDir}/b.md`)).toBe(true);
  });
});

// ─── PARCHE-009 AC6 CLI: --dir in repo → exit 1; --allow-in-repo → gitignore ─

describe('PARCHE-009 AC6 CLI — git repo protection', () => {
  it('--dir inside git repo → exit 1 with clear message, nothing created', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const fs = new MemoryFilesystem({ '/repo/.git/HEAD': 'ref: refs/heads/main\n' });
    const svc = makeServices(parche, { fs });

    const r = await makeCli(
      svc,
      ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--dir', '/repo/sub'],
      { isTTY: false },
    );

    expect(r.code).toBe(1);
    const errText = r.err.join('\n');
    expect(errText).toBeTruthy();
    // Target dir was never created
    expect(await fs.exists('/repo/sub')).toBe(false);
    // No credential written
    const creds = new CredentialsStore(fs, svc.homedir);
    const allSlugs = await creds.listSlugs();
    expect(allSlugs.length).toBe(0);
  });

  it('--allow-in-repo → accepted and .gitignore contains .chamba-sync/', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const fs = new MemoryFilesystem({ '/repo/.git/HEAD': 'ref: refs/heads/main\n' });
    const svc = makeServices(parche, { fs });

    const r = await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--dir',
      '/repo/vault',
      '--allow-in-repo',
      '--yes',
    ]);

    expect(r.code).toBe(0);
    const gitignore = await fs.readFile('/repo/.gitignore');
    expect(gitignore).toContain('.chamba-sync/');
  });
});

// ─── PARCHE-009 AC7 CLI: --dir / and --dir ~ → exit 1 ───────────────────────

describe('PARCHE-009 AC7 CLI — root and home path rejection', () => {
  it('--dir / → exit 1 with clear message, no credential', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });
    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    const r = await makeCli(
      svc,
      ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--dir', '/'],
      { isTTY: false },
    );

    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toBeTruthy();
    const creds = new CredentialsStore(fs, svc.homedir);
    expect((await creds.listSlugs()).length).toBe(0);
  });

  it('--dir ~ (home) → exit 1 with clear message, no credential', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });
    const fs = new MemoryFilesystem();
    // services.homedir is '/home/test'
    const svc = makeServices(parche, { fs });

    const r = await makeCli(
      svc,
      ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--dir', '~'],
      { isTTY: false },
    );

    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toBeTruthy();
    const creds = new CredentialsStore(fs, svc.homedir);
    expect((await creds.listSlugs()).length).toBe(0);
  });
});

// ─── PARCHE-009 AC8 CLI: already_linked ──────────────────────────────────────

describe('PARCHE-009 AC8 CLI — already linked to another vault', () => {
  it('join --dir already linked to otro-slug → exit 1 mentioning slug name', async () => {
    const parche = new FakeParche(makeClock());
    // Join first vault to /shared/vault
    const g1 = parche.seedGroup({ slug: 'vault-one', name: 'Vault One' });
    parche.addInvite({ code: 'AAAA-1111', groupId: g1.id, role: 'editor' });
    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    const r1 = await makeCli(svc, [
      'join',
      'AAAA-1111',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--dir',
      '/shared/vault',
      '--yes',
    ]);
    expect(r1.code).toBe(0);

    // Try to join another vault to the same /shared/vault
    const g2 = parche.seedGroup({ slug: 'vault-two', name: 'Vault Two' });
    parche.addInvite({ code: 'BBBB-2222', groupId: g2.id, role: 'editor' });

    const r2 = await makeCli(
      svc,
      [
        'join',
        'BBBB-2222',
        '--name',
        'Joys',
        '--email',
        'j@x.dev',
        '--dir',
        '/shared/vault',
        '--yes',
      ],
      { isTTY: false },
    );

    expect(r2.code).toBe(1);
    const errText = r2.err.join('\n');
    // Must mention the slug name that already owns this path
    expect(errText).toMatch(/vault-one/);
  });

  it('vault link --dir already linked → exit 1 mentioning other slug', async () => {
    const parche = new FakeParche(makeClock());
    const g1 = parche.seedGroup({ slug: 'vault-one', name: 'Vault One' });
    parche.addInvite({ code: 'AAAA-1111', groupId: g1.id, role: 'editor' });
    const g2 = parche.seedGroup({ slug: 'vault-two', name: 'Vault Two' });
    parche.addInvite({ code: 'BBBB-2222', groupId: g2.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    // Join both vaults to different dirs
    await makeCli(svc, [
      'join',
      'AAAA-1111',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--dir',
      '/vault-one-dir',
      '--yes',
    ]);
    await makeCli(svc, [
      'join',
      'BBBB-2222',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--dir',
      '/vault-two-dir',
      '--yes',
    ]);

    // Now try to link vault-two to /vault-one-dir (already used by vault-one)
    const r = await makeCli(svc, ['link', 'vault-two', '--dir', '/vault-one-dir', '--yes'], {
      isTTY: false,
    });

    expect(r.code).toBe(1);
    const errText = r.err.join('\n');
    expect(errText).toMatch(/vault-one/);
  });
});

// ─── PARCHE-009 AC8 MCP tool: already_linked → isError ──────────────────────

describe('PARCHE-009 AC8 MCP tool — already_linked isError', () => {
  it('chamba_vault_join with dir already linked → isError', async () => {
    const parche = new FakeParche(makeClock());
    const g1 = parche.seedGroup({ slug: 'vault-one', name: 'Vault One' });
    parche.addInvite({ code: 'AAAA-3333', groupId: g1.id, role: 'editor' });
    const g2 = parche.seedGroup({ slug: 'vault-two', name: 'Vault Two' });
    parche.addInvite({ code: 'BBBB-4444', groupId: g2.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });
    const { client, server } = await connect(svc);

    // First join with dir
    await client.callTool({
      name: 'chamba_vault_join',
      arguments: {
        code: 'AAAA-3333',
        name: 'Joys',
        email: 'j@x.dev',
        dir: '/linked/vault',
        confirmUpload: true,
      },
    });

    // Second join to same dir → should be isError
    const result = await client.callTool({
      name: 'chamba_vault_join',
      arguments: {
        code: 'BBBB-4444',
        name: 'Joys',
        email: 'j@x.dev',
        dir: '/linked/vault',
        confirmUpload: true,
      },
    });

    const r = result as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);

    await server.close();
  });
});

// ─── PARCHE-009 AC9 extended: cursor matches server, pendingAdoption absent, second sync 0/0 ─

describe('PARCHE-009 AC9 extended — second sync after link reports 0/0', () => {
  it('second vault sync after link --yes reports pushed 0 / pulled 0', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    // First join (empty vault)
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);

    const newVaultDir = '/new/vault';
    await fs.mkdir(newVaultDir);
    await fs.writeFile(`${newVaultDir}/note.md`, '# Note\n');

    // Link to new dir
    const r1 = await makeCli(svc, ['link', 'team-alpha', '--dir', newVaultDir, '--yes']);
    expect(r1.code).toBe(0);

    // Verify cred.dir == newVaultDir
    const creds = new CredentialsStore(fs, svc.homedir);
    const allSlugs = await creds.listSlugs();
    const found = allSlugs.find((s) => s.slug === 'team-alpha');
    if (!found) throw new Error('team-alpha credential not found');
    const cred = await creds.get(found.server, 'team-alpha');
    expect(cred?.dir).toBe(newVaultDir);

    // Verify pendingAdoption is absent from state
    const state = await readState(fs, newVaultDir);
    expect(state?.pendingAdoption).toBeUndefined();

    // Second sync should be a no-op (0 pushed / 0 pulled)
    const r2 = await makeCli(svc, ['sync']);
    expect(r2.code).toBe(0);
    const outText = r2.out.join('\n');
    expect(outText).toContain('pushed 0');
    expect(outText).toContain('pulled 0');
  });
});

// ─── PARCHE-009 D1: re-join without --dir, without --yes, with syncable files ─

describe('PARCHE-009 D1 — re-join universal gate', () => {
  it('join without --yes, no TTY, vault has files: exit 1, no upload (D1)', async () => {
    // D1: vault dir pre-seeded with files → gate triggers; no --yes, no TTY → exit 1
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const vaultDir = '/home/test/.chamba/vaults/team-alpha';
    await fs.mkdir(`${vaultDir}/.obsidian`);
    await fs.writeFile(`${vaultDir}/existing.md`, '# Existing note\n');

    const svc = makeServices(parche, { fs });

    const requestsBefore = parche.requestLog.length;
    const r = await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev'], {
      isTTY: false,
    });

    expect(r.code).toBe(1);
    const putRequests = parche.requestLog
      .slice(requestsBefore)
      .filter((req) => req.method === 'PUT');
    expect(putRequests.length).toBe(0);
  });

  it('join with TTY answered "n" (vault has files) → exit 0, no upload (D1)', async () => {
    // D1: vault dir pre-seeded with files → gate triggers; TTY 'n' → exit 0 (deliberate choice)
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const vaultDir = '/home/test/.chamba/vaults/team-alpha';
    await fs.mkdir(`${vaultDir}/.obsidian`);
    // Pre-seed syncable file so gate triggers
    await fs.writeFile(`${vaultDir}/note.md`, '# Note\n');
    const svc = makeServices(parche, { fs });

    const requestsBefore = parche.requestLog.length;
    const r = await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev'], {
      isTTY: true,
      prompt: async () => 'n',
    });

    // TTY decline → exit 0 (deliberate user choice per spec)
    expect(r.code).toBe(0);
    const putRequests = parche.requestLog
      .slice(requestsBefore)
      .filter((req) => req.method === 'PUT');
    expect(putRequests.length).toBe(0);
  });

  it('join with TTY answered "s" (vault has files) → uploads (D1)', async () => {
    // D1: vault dir pre-seeded with files → gate triggers; TTY 's' → uploads
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const vaultDir = '/home/test/.chamba/vaults/team-alpha';
    await fs.mkdir(`${vaultDir}/.obsidian`);
    await fs.writeFile(`${vaultDir}/note.md`, '# Note\n');
    const svc = makeServices(parche, { fs });

    const requestsBefore = parche.requestLog.length;
    const r = await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev'], {
      isTTY: true,
      prompt: async () => 's',
    });

    expect(r.code).toBe(0);
    const putRequests = parche.requestLog
      .slice(requestsBefore)
      .filter((req) => req.method === 'PUT');
    expect(putRequests.length).toBeGreaterThan(0);
  });
});

// ─── PARCHE-009 D2 CLI/tool: VaultDirMissing ─────────────────────────────────

describe('PARCHE-009 D2 CLI — vault dir deleted', () => {
  it('vault sync → exit 1 with "ya no existe" message when dir deleted (D2)', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);

    // Delete the vault dir by removing state.json and the marker
    // In MemoryFilesystem we simulate by overwriting cred.dir to a non-existent path
    const creds = new CredentialsStore(fs, svc.homedir);
    const allSlugs = await creds.listSlugs();
    const found = allSlugs[0];
    if (!found) throw new Error('slug not found');
    const cred = await creds.get(found.server, found.slug);
    // Point cred to a non-existent dir
    if (!cred) throw new Error('credential not found');
    await creds.set(found.server, found.slug, { ...cred, dir: '/deleted/vault' });

    const r = await makeCli(svc, ['sync']);
    expect(r.code).toBe(1);
    const errText = r.err.join('\n');
    // Must mention "ya no existe" or the path
    expect(errText).toMatch(/ya no existe/i);
  });

  it('vault status shows "[carpeta ya no existe" marker (D2)', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);

    // Point cred to non-existent dir
    const creds = new CredentialsStore(fs, svc.homedir);
    const allSlugs = await creds.listSlugs();
    const found = allSlugs[0];
    if (!found) throw new Error('slug not found');
    const cred = await creds.get(found.server, found.slug);
    if (!cred) throw new Error('credential not found');
    await creds.set(found.server, found.slug, { ...cred, dir: '/deleted/vault' });

    const r = await makeCli(svc, ['status']);
    const allOut = r.out.join('\n');
    // Must show the "carpeta ya no existe" marker
    expect(allOut).toContain('carpeta ya no existe');
  });
});

// ─── PARCHE-009 R1 tool-level: chamba_vault_sync on pendingAdoption → isError ─

describe('PARCHE-009 R1 MCP tool — chamba_vault_sync pendingAdoption isError', () => {
  it('chamba_vault_sync with pendingAdoption vault → isError, no push (R1)', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });
    const { client, server } = await connect(svc);

    // Join without confirming (no --yes, no TTY in makeCli → gate not confirmed)
    // Use CLI makeCli to set up the pendingAdoption state
    const vaultDir = '/home/test/.chamba/vaults/team-alpha';
    await fs.mkdir(`${vaultDir}/.obsidian`);
    await fs.writeFile(`${vaultDir}/note.md`, '# Note\n');
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev'], {
      isTTY: false,
    });

    // State should have pendingAdoption=true now
    const state = await readState(fs, vaultDir);
    expect(state?.pendingAdoption).toBe(true);

    const requestsBefore = parche.requestLog.length;
    const result = await client.callTool({ name: 'chamba_vault_sync', arguments: {} });

    const r = result as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    const putRequests = parche.requestLog
      .slice(requestsBefore)
      .filter((req) => req.method === 'PUT');
    expect(putRequests.length).toBe(0);

    await server.close();
  });
});

// ─── PARCHE-009 MCP chamba_vault_join: needsConfirmation / in_repo ────────────

describe('PARCHE-009 MCP chamba_vault_join — needsConfirmation and in_repo', () => {
  it('dir with content and no confirmUpload → needsConfirmation structuredContent (AC12)', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const vaultDir = '/content/vault';
    const fs = new MemoryFilesystem();
    await fs.mkdir(vaultDir);
    await fs.writeFile(`${vaultDir}/note-01.md`, '# Note 1\n');
    await fs.writeFile(`${vaultDir}/note-02.md`, '# Note 2\n');

    const svc = makeServices(parche, { fs });
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_join',
      arguments: { code: 'K7QX-M2RP', name: 'Joys', email: 'j@x.dev', dir: vaultDir },
    });

    const r = result as {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent?: Record<string, unknown>;
    };

    // Must NOT be isError
    expect(r.isError).toBeFalsy();

    // structuredContent must have needsConfirmation=true
    const sc = structuredOf(result);
    expect(sc.needsConfirmation).toBe(true);
    expect(sc.syncableCount).toBe(2);

    // No PUT requests sent
    const putRequests = parche.requestLog.filter((req) => req.method === 'PUT');
    expect(putRequests.length).toBe(0);

    await server.close();
  });

  it('dir with content + confirmUpload:true → uploads exactly that count', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const vaultDir = '/content/vault2';
    const fs = new MemoryFilesystem();
    await fs.mkdir(vaultDir);
    for (let i = 1; i <= 5; i++) {
      await fs.writeFile(`${vaultDir}/note-0${i}.md`, `# Note ${i}\n`);
    }

    const svc = makeServices(parche, { fs });
    const { client, server } = await connect(svc);

    const requestsBefore = parche.requestLog.length;
    const result = await client.callTool({
      name: 'chamba_vault_join',
      arguments: {
        code: 'K7QX-M2RP',
        name: 'Joys',
        email: 'j@x.dev',
        dir: vaultDir,
        confirmUpload: true,
      },
    });

    const r = result as { isError?: boolean };
    expect(r.isError).toBeFalsy();

    const putRequests = parche.requestLog
      .slice(requestsBefore)
      .filter((req) => req.method === 'PUT');
    expect(putRequests.length).toBe(5);

    await server.close();
  });

  it('dir inside git repo → isError mentioning --allow-in-repo (D5)', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const fs = new MemoryFilesystem({ '/repo/.git/HEAD': 'ref: refs/heads/main\n' });
    const svc = makeServices(parche, { fs });
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_join',
      arguments: { code: 'K7QX-M2RP', name: 'Joys', email: 'j@x.dev', dir: '/repo/vault' },
    });

    const r = result as { isError?: boolean; content: Array<{ text: string }> };
    expect(r.isError).toBe(true);
    const txt = textOf(result);
    expect(txt).toContain('--allow-in-repo');

    await server.close();
  });
});

// ─── PARCHE-009 D2 MCP tool: chamba_vault_sync → isError when dir deleted ───

describe('PARCHE-009 D2 MCP tool — chamba_vault_sync isError when dir missing', () => {
  it('chamba_vault_sync → isError when vault dir no longer exists (D2)', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });
    const { client, server } = await connect(svc);

    // Join first (creates vault)
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);

    // Point cred to a non-existent dir
    const creds = new CredentialsStore(fs, svc.homedir);
    const allSlugs = await creds.listSlugs();
    const found = allSlugs[0];
    if (!found) throw new Error('slug not found');
    const cred = await creds.get(found.server, found.slug);
    if (!cred) throw new Error('credential not found');
    await creds.set(found.server, found.slug, { ...cred, dir: '/deleted/vault' });

    const result = await client.callTool({ name: 'chamba_vault_sync', arguments: {} });
    const r = result as { isError?: boolean };
    expect(r.isError).toBe(true);

    await server.close();
  });
});

// ─── Fix 1: no-TTY adoption gate message must only mention vault link ─────────

describe('AC4 no-TTY gate message — only vault link, never vault join', () => {
  it('no-TTY, no --yes, syncable files: message mentions vault link and NOT vault join', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const vaultDir = '/home/test/.chamba/vaults/team-alpha';
    await fs.mkdir(`${vaultDir}/.obsidian`);
    await fs.writeFile(`${vaultDir}/note.md`, '# Note\n');
    const svc = makeServices(parche, { fs });

    const r = await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev'], {
      isTTY: false,
    });

    expect(r.code).toBe(1);
    const allOutput = [...r.out, ...r.err].join('\n');
    expect(allOutput).toContain('vault link');
    expect(allOutput).not.toContain('vault join');
  });
});

// ─── Fix 2: chamba_vault_join confirmUpload:true — no double join ─────────────

describe('chamba_vault_join confirmUpload:true — resumes existing pending, no second join', () => {
  it('first call → needsConfirmation (no upload); second call with confirmUpload:true → uploads N, only 1 join total (with dir)', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const vaultDir = '/custom/vault';
    const fs = new MemoryFilesystem();
    await fs.mkdir(vaultDir);
    for (let i = 1; i <= 3; i++) {
      await fs.writeFile(`${vaultDir}/note-0${i}.md`, `# Note ${i}\n`);
    }

    const svc = makeServices(parche, { fs });
    const { client, server } = await connect(svc);

    const joinsBefore = parche.requestLog.filter((r) => r.url.includes('/join')).length;

    // First call: should return needsConfirmation
    const r1 = await client.callTool({
      name: 'chamba_vault_join',
      arguments: { code: 'K7QX-M2RP', name: 'Joys', email: 'j@x.dev', dir: vaultDir },
    });
    expect((r1 as { isError?: boolean }).isError).toBeFalsy();
    const sc1 = structuredOf(r1);
    expect(sc1.needsConfirmation).toBe(true);
    expect(sc1.syncableCount).toBe(3);

    // No PUT blobs on first call
    expect(parche.requestLog.filter((r) => r.method === 'PUT').length).toBe(0);

    // Second call with confirmUpload:true — should NOT re-join
    const r2 = await client.callTool({
      name: 'chamba_vault_join',
      arguments: {
        code: 'K7QX-M2RP',
        name: 'Joys',
        email: 'j@x.dev',
        dir: vaultDir,
        confirmUpload: true,
      },
    });
    expect((r2 as { isError?: boolean }).isError).toBeFalsy();

    // Exactly 3 PUT blobs uploaded
    const putRequests = parche.requestLog.filter((r) => r.method === 'PUT');
    expect(putRequests.length).toBe(3);

    // Only 1 join total
    const joinsAfter = parche.requestLog.filter((r) => r.url.includes('/join')).length;
    expect(joinsAfter - joinsBefore).toBe(1);

    await server.close();
  });

  it('first call without dir → needsConfirmation; second call with confirmUpload:true → uploads, only 1 join total', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const vaultDir = '/home/test/.chamba/vaults/team-alpha';
    const fs = new MemoryFilesystem();
    await fs.mkdir(vaultDir);
    await fs.writeFile(`${vaultDir}/note.md`, '# Note\n');

    const svc = makeServices(parche, { fs });
    const { client, server } = await connect(svc);

    const joinsBefore = parche.requestLog.filter((r) => r.url.includes('/join')).length;

    // First call (no dir)
    const r1 = await client.callTool({
      name: 'chamba_vault_join',
      arguments: { code: 'K7QX-M2RP', name: 'Joys', email: 'j@x.dev' },
    });
    expect((r1 as { isError?: boolean }).isError).toBeFalsy();
    const sc1 = structuredOf(r1);
    expect(sc1.needsConfirmation).toBe(true);

    // Second call with confirmUpload:true (no dir)
    const r2 = await client.callTool({
      name: 'chamba_vault_join',
      arguments: { code: 'K7QX-M2RP', name: 'Joys', email: 'j@x.dev', confirmUpload: true },
    });
    expect((r2 as { isError?: boolean }).isError).toBeFalsy();

    // Only 1 join total
    const joinsAfter = parche.requestLog.filter((r) => r.url.includes('/join')).length;
    expect(joinsAfter - joinsBefore).toBe(1);

    // At least 1 PUT
    expect(parche.requestLog.filter((r) => r.method === 'PUT').length).toBeGreaterThan(0);

    await server.close();
  });
});

// ─── Fix 3: vault leave — message when dir already gone ──────────────────────

describe('vault leave — message when vault dir no longer exists', () => {
  it('leave prints "ya no existe" when vault dir has been deleted', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    // Join (creates vault dir)
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);

    // Point cred to a non-existent dir
    const creds = new CredentialsStore(fs, svc.homedir);
    const allSlugs = await creds.listSlugs();
    const found = allSlugs[0];
    if (!found) throw new Error('slug not found');
    const cred = await creds.get(found.server, found.slug);
    if (!cred) throw new Error('credential not found');
    await creds.set(found.server, found.slug, { ...cred, dir: '/deleted/vault' });

    const r = await makeCli(svc, ['leave', found.slug]);
    const allOut = [...r.out, ...r.err].join('\n');
    expect(allOut).toContain('ya no existe');
    expect(r.code).toBe(0);
  });
});

// ─── Fix 4: chamba_parche_status — pendingAdoption shows without planPush ────

describe('chamba_parche_status — pendingAdoption shown without running planPush', () => {
  it('status shows "pendiente de confirmar" when pendingAdoption, no planPush errors', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const vaultDir = '/home/test/.chamba/vaults/team-alpha';
    const fs = new MemoryFilesystem();
    await fs.mkdir(`${vaultDir}/.obsidian`);
    await fs.writeFile(`${vaultDir}/note.md`, '# Note\n');

    const svc = makeServices(parche, { fs });
    const { client, server } = await connect(svc);

    // Join without --yes → pendingAdoption=true
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev'], {
      isTTY: false,
    });

    const result = await client.callTool({ name: 'chamba_parche_status', arguments: {} });
    const txt = textOf(result);
    expect(txt).toMatch(/pendiente de confirmar/);
    // Must not contain planPush-derived numbers like "1 change(s)"
    expect(txt).not.toMatch(/\d+ change\(s\)/);

    await server.close();
  });
});

// ─── Fix 5: vault link same dir — nada que hacer / recovery path ─────────────

describe('vault link same dir — idempotent when not pending, recovery when pending', () => {
  it('link to same dir when not pending → exit 0, nothing reset, message "nada que hacer"', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    // Join with --yes so pendingAdoption is cleared
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--yes']);

    const creds = new CredentialsStore(fs, svc.homedir);
    const allSlugs = await creds.listSlugs();
    const found = allSlugs[0];
    if (!found) throw new Error('slug not found');
    const currentVaultDir = `/home/test/.chamba/vaults/${found.slug}`;

    const putsBefore = parche.requestLog.filter((r) => r.method === 'PUT').length;
    const r = await makeCli(svc, ['link', found.slug, '--dir', currentVaultDir]);

    expect(r.code).toBe(0);
    const allOut = [...r.out, ...r.err].join('\n');
    expect(allOut).toContain('nada que hacer');

    // No additional syncs/uploads
    const putsAfter = parche.requestLog.filter((r) => r.method === 'PUT').length;
    expect(putsAfter).toBe(putsBefore);
  });

  it('link to same dir when pending → recovery path clears pendingAdoption', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const vaultDir = '/home/test/.chamba/vaults/team-alpha';
    await fs.mkdir(`${vaultDir}/.obsidian`);
    await fs.writeFile(`${vaultDir}/note.md`, '# Note\n');
    const svc = makeServices(parche, { fs });

    // Join without --yes → pendingAdoption=true
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev'], {
      isTTY: false,
    });

    // Re-link same dir with --yes → recovery path
    const r = await makeCli(svc, ['link', 'team-alpha', '--dir', vaultDir, '--yes']);
    expect(r.code).toBe(0);

    // pendingAdoption must be cleared
    const state = await readState(fs, vaultDir);
    expect(state?.pendingAdoption).toBeUndefined();
  });
});
