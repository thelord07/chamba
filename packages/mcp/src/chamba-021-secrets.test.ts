/**
 * chamba-021-secrets.test.ts — CHAMBA-021 S8 tests: `vault sync`/`vault status`
 * reporting, `vault allow-secret` CLI (TTY-gated), and the
 * `chamba_vault_allow_secret` tool (never writes).
 */
import {
  CredentialsStore,
  FakeHash,
  FakeParche,
  FakeRandom,
  MemoryFilesystem,
  writeState,
} from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { runVaultCli, type VaultCliDeps } from './cli/vault.js';
import { createServer } from './server.js';
import type { Services } from './services.js';

const silentLogger = pino({ level: 'silent' });
const VAULT = '/vault';
const SERVER = 'https://parche.example.com';
const SLUG = 'test-group';

function makeClock(iso = '2026-10-29T12:00:00.000Z') {
  return {
    now: () => new Date(iso),
    today: () => iso.slice(0, 10),
    sleep: () => Promise.resolve(),
  };
}

async function setupBoundVault(secretBody: string) {
  const parche = new FakeParche(makeClock());
  const group = parche.seedGroup({ slug: SLUG, name: 'Test Group' });
  parche.addInvite({ code: 'ABCD-1234', groupId: group.id, role: 'editor' });
  const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop', role: 'editor' });

  const fs = new MemoryFilesystem({
    [`${VAULT}/.obsidian/app.json`]: '{}',
    [`${VAULT}/secret.md`]: secretBody,
  });
  const creds = new CredentialsStore(fs, '/home/test');
  await creds.set(SERVER, SLUG, {
    token,
    user: { id: 'u1', name: 'joys' },
    device: { id: 'dev1', label: 'laptop' },
    role: 'editor',
    dir: VAULT,
  });
  await writeState(fs, VAULT, { server: SERVER, slug: SLUG, cursor: 0, files: {} });

  const services: Services = {
    fs,
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
    random: new FakeRandom(),
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
    platform: 'linux',
    username: 'testuser',
  };

  return { services, fs };
}

function makeCli(
  svc: Services,
  argv: string[],
  opts: { isTTY?: boolean; prompt?: (q: string) => Promise<string> } = {},
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
    prompt: opts.prompt ?? (async () => ''),
    isTTY: opts.isTTY ?? false,
  };
  return runVaultCli(argv, deps).then(() => ({ out, err, code }));
}

const SECRET_BODY = `token: ${'pch_'}${'A'.repeat(24)}\n`;

describe('vault sync — reports blocked secrets, exits 0', () => {
  it('prints a blocked-secret line and exits 0 (not an error)', async () => {
    const { services } = await setupBoundVault(SECRET_BODY);
    const r = await makeCli(services, ['sync', SLUG]);
    expect(r.code).toBe(0);
    const allOutput = [...r.out, ...r.err].join('\n');
    expect(allOutput).toContain('bloqueado por posible secreto');
  });
});

describe('vault status — lists blocked secrets', () => {
  it('lists the blocked path after a sync', async () => {
    const { services } = await setupBoundVault(SECRET_BODY);
    await makeCli(services, ['sync', SLUG]);
    const out: string[] = [];
    await runVaultCli(['status'], {
      services,
      stdout: (m) => out.push(m),
      stderr: () => {},
      exit: () => {},
      prompt: async () => '',
      isTTY: false,
    });
    expect(out.join('\n')).toContain('secrets:');
    expect(out.join('\n')).toContain('secret.md');
  });
});

describe('vault allow-secret CLI (D-Q2)', () => {
  it('rejects an invalid fingerprint', async () => {
    const { services } = await setupBoundVault(SECRET_BODY);
    const r = await makeCli(services, ['allow-secret', 'not-hex', '--path', 'secret.md'], {
      isTTY: true,
    });
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('fingerprint inválido');
  });

  it('refuses without a TTY', async () => {
    const { services } = await setupBoundVault(SECRET_BODY);
    const r = await makeCli(services, ['allow-secret', 'a1b2c3d4e5f6', '--path', 'secret.md'], {
      isTTY: false,
    });
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('terminal interactiva');
  });

  it('writes the allowlist only when the retyped path matches', async () => {
    const { services, fs } = await setupBoundVault(SECRET_BODY);
    await makeCli(services, ['sync', SLUG]); // populate state.blockedSecret
    const r = await makeCli(services, ['allow-secret', 'a1b2c3d4e5f6', '--path', 'secret.md'], {
      isTTY: true,
      prompt: async () => 'secret.md',
    });
    expect(r.code).toBe(0);
    expect(await fs.exists(`${VAULT}/.chamba-sync/secret-allowlist.json`)).toBe(true);
  });

  it('does NOT write the allowlist when the retyped path does not match', async () => {
    const { services, fs } = await setupBoundVault(SECRET_BODY);
    await makeCli(services, ['sync', SLUG]);
    await makeCli(services, ['allow-secret', 'a1b2c3d4e5f6', '--path', 'secret.md'], {
      isTTY: true,
      prompt: async () => 'wrong-path.md',
    });
    expect(await fs.exists(`${VAULT}/.chamba-sync/secret-allowlist.json`)).toBe(false);
  });

  it('fails with a clear message when there is no bound vault', async () => {
    const parche = new FakeParche(makeClock());
    const services: Services = {
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
      random: new FakeRandom(),
      parchePullTtlMin: 5,
      vaultMutex: new Map(),
      platform: 'linux',
      username: 'testuser',
    };
    const r = await makeCli(services, ['allow-secret', 'a1b2c3d4e5f6', '--path', 'x.md'], {
      isTTY: true,
    });
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('vault join');
  });
});

describe('chamba_vault_allow_secret tool — never writes', () => {
  async function connect(svc: Services) {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const server = createServer(silentLogger, svc);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([server.connect(st), client.connect(ct)]);
    return { client, server };
  }

  it('returns the CLI command and never writes the allowlist', async () => {
    const { services, fs } = await setupBoundVault(SECRET_BODY);
    const { client, server } = await connect(services);

    const result = await client.callTool({
      name: 'chamba_vault_allow_secret',
      arguments: { fingerprint: 'a1b2c3d4e5f6', path: 'secret.md' },
    });

    const structured = (result as { structuredContent: Record<string, unknown> }).structuredContent;
    expect(structured.wrote).toBe(false);
    expect(String(structured.command)).toContain('vault allow-secret a1b2c3d4e5f6');
    expect(await fs.exists(`${VAULT}/.chamba-sync/secret-allowlist.json`)).toBe(false);

    await server.close();
  });

  it('rejects an invalid fingerprint without touching disk', async () => {
    const { services, fs } = await setupBoundVault(SECRET_BODY);
    const { client, server } = await connect(services);

    const result = await client.callTool({
      name: 'chamba_vault_allow_secret',
      arguments: { fingerprint: 'nope', path: 'secret.md' },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(await fs.exists(`${VAULT}/.chamba-sync/secret-allowlist.json`)).toBe(false);

    await server.close();
  });
});
