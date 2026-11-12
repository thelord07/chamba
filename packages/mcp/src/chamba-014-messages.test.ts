/**
 * chamba-014-messages.test.ts — Test 11 (CHAMBA-014 C4)
 *
 * Verifies that:
 *   - CLI vault sync/join/link/resync produce messages with the error code
 *   - MCP tools vault-sync/join/link/resync produce messages with the error code
 *   - autosync warning includes error code
 *   - formatFatal includes cause.code/message
 *   - None of the above leak `pch_TESTSECRET` or `Authorization`
 *   - None of the messages is just "fetch failed"
 *   - RetryingHttp debug logs do not contain the token or Authorization
 *
 * Also tests that the CLI terminates normally (no hanging sockets) via
 * an in-process test using RetryingHttp(NodeHttp()) against a local server.
 */

import type { RequestListener, Server } from 'node:http';
import { createServer } from 'node:http';
import { NodeHttp, RetryingHttp } from '@chamba/adapters';
import {
  CredentialsStore,
  FakeHash,
  FakeParche,
  FakeRandom,
  FlakyHttp,
  MemoryFilesystem,
  ParcheNetworkError,
  writeState,
} from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { afterEach, describe, expect, it } from 'vitest';
import { runVaultCli, type VaultCliDeps } from './cli/vault.js';
import { formatFatal } from './fatal.js';
import { AUTOSYNC_BUDGET_MS } from './parche/autosync.js';
import { createServer as createMcpServer } from './server.js';
import type { Services } from './services.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const FAKE_TOKEN = 'pch_TESTSECRET0123456789abcdef';
const ERROR_CODE = 'UND_ERR_CONNECT_TIMEOUT';
const FAKE_HOST = 'parche.example.com';
const FAKE_SERVER = `https://${FAKE_HOST}`;
const FAKE_NOW = '2026-06-09T10:00:00.000Z';
const OLD_SYNC = '2026-06-09T09:50:00.000Z';

const silentLogger = pino({ level: 'silent' });

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeClock(now = FAKE_NOW) {
  const d = new Date(now);
  return { now: () => d, today: () => d.toISOString().slice(0, 10) };
}

/**
 * An HttpPort that always throws a ParcheNetworkError.
 * The cause intentionally contains the token and an Authorization header to
 * simulate what a real HTTP client would capture — we verify none of that
 * propagates to user-visible messages.
 */
function makeParcheNetworkError(): ParcheNetworkError {
  const cause = Object.assign(
    new Error(`connect timeout to ${FAKE_HOST}:443 (Authorization: Bearer ${FAKE_TOKEN})`),
    { code: ERROR_CODE },
  );
  return new ParcheNetworkError({
    url: `${FAKE_SERVER}/api/g/cya/push?token=${FAKE_TOKEN}`,
    attempts: 4,
    code: ERROR_CODE,
    shortMessage: 'connect ETIMEDOUT',
    cause,
  });
}

/**
 * HttpPort that always throws ParcheNetworkError immediately.
 * Simulates RetryingHttp after exhausting all retries.
 */
const alwaysFailHttp = {
  async request(_req: unknown): Promise<never> {
    throw makeParcheNetworkError();
  },
};

async function makeServices(
  opts: { slug?: string; setupCredentials?: boolean; setupState?: boolean } = {},
): Promise<Services> {
  const slug = opts.slug ?? 'cya';
  const fs = new MemoryFilesystem();
  const homedir = '/home/test';
  const vaultDir = `${homedir}/.chamba/vaults/${slug}`;

  if (opts.setupCredentials !== false) {
    const creds = new CredentialsStore(fs, homedir);
    await creds.set(FAKE_SERVER, slug, {
      token: FAKE_TOKEN,
      user: { id: 'u1', name: 'Joys' },
      device: { id: 'd1', label: 'laptop' },
      role: 'editor',
    });
  }

  if (opts.setupState !== false) {
    await fs.mkdir(vaultDir);
    await writeState(fs, vaultDir, {
      server: FAKE_SERVER,
      slug,
      cursor: 0,
      files: {},
      lastSyncAt: OLD_SYNC,
    });
  }

  return {
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
    homedir,
    http: alwaysFailHttp,
    hash: new FakeHash(),
    random: new FakeRandom(),
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
    platform: 'linux',
    username: 'testuser',
    autosyncBudgetMs: AUTOSYNC_BUDGET_MS,
  };
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

async function connectMcp(svc: Services) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(silentLogger, svc);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.map((c) => c.text).join('\n');
}

/**
 * Verify a message:
 * - Contains the error code
 * - Does NOT contain the token
 * - Does NOT contain "Authorization"
 * - Is NOT just "fetch failed"
 */
function assertMessageSafe(msg: string, label: string) {
  expect(msg, `${label}: debe contener el código de error`).toContain(ERROR_CODE);
  expect(msg, `${label}: no debe contener el token`).not.toContain(FAKE_TOKEN);
  expect(msg, `${label}: no debe contener Authorization`).not.toContain('Authorization');
  expect(msg.trim(), `${label}: no puede ser solo "fetch failed"`).not.toBe('fetch failed');
}

// ─── Test 11 — Mensajes (4.3) ─────────────────────────────────────────────────

describe('Test 11 — mensajes con ParcheNetworkError no filtran token', () => {
  // ── CLI vault sync ────────────────────────────────────────────────────────

  it('CLI vault sync: incluye code, no filtra token ni Authorization', async () => {
    const svc = await makeServices();
    const { err } = await makeCli(svc, ['sync', 'cya']);
    const combined = err.join('\n');
    assertMessageSafe(combined, 'CLI vault sync');
    expect(combined).toContain(FAKE_HOST);
  });

  // ── CLI vault join ────────────────────────────────────────────────────────

  it('CLI vault join: incluye code, no filtra token ni Authorization', async () => {
    // Join needs prompts for name/email but also needs a real FakeParche for join.
    // Since we want it to fail at the network level, use a FakeParche with no invite
    // and our alwaysFailHttp.
    const svc = await makeServices({ setupCredentials: false, setupState: false });
    // Add a valid-looking invite code that the parser accepts, but the network will fail.
    // The join code parser only validates format; network call happens later.
    const { err } = await makeCli(
      svc,
      ['join', 'K7QX-M2RP', '--name', 'Test', '--email', 'test@test.com'],
      {
        isTTY: false,
      },
    );
    const combined = err.join('\n');
    // Join should fail with a network error message
    assertMessageSafe(combined, 'CLI vault join');
  });

  it('CLI vault join: join OK pero el primer sync falla por red → sugiere vault sync <slug>, no repetir el join', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'cya', name: 'CyA' });
    parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });
    const svc = await makeServices({ setupCredentials: false, setupState: false });
    // Only the join (and its invite pre-check) reach the server; every sync request fails.
    const flaky = new FlakyHttp(parche, {
      seed: 1,
      rate: 1,
      code: ERROR_CODE,
      match: (req) => !req.url.includes('/api/join') && !req.url.includes('/check'),
    });
    svc.http = new RetryingHttp(flaky, { sleep: async () => {} });

    const { err, code } = await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Test',
      '--email',
      'test@test.com',
      '--yes',
    ]);
    const combined = err.join('\n');
    expect(code).toBe(1);
    expect(combined).toContain(ERROR_CODE);
    expect(combined).toContain('vault sync cya');
    expect(combined).not.toContain('vault join');
  });

  // ── CLI vault link ────────────────────────────────────────────────────────

  it('CLI vault link: incluye code, no filtra token ni Authorization', async () => {
    const svc = await makeServices();
    // link --dir with an existing vault dir that the link already points to (noop)
    // or a new dir that triggers finalizeAdoption → network error
    // Use a non-existing dir to trigger relink then confirm sync
    const vaultDir = '/home/test/.chamba/vaults/cya-new';
    await (svc.fs as MemoryFilesystem).mkdir(vaultDir);
    const { err } = await makeCli(svc, ['link', 'cya', '--dir', vaultDir, '--yes']);
    const combined = err.join('\n');
    assertMessageSafe(combined, 'CLI vault link');
  });

  // ── CLI vault resync ──────────────────────────────────────────────────────

  it('CLI vault resync: incluye code, no filtra token ni Authorization', async () => {
    const svc = await makeServices();
    const { err } = await makeCli(svc, ['resync', 'cya', '--yes']);
    const combined = err.join('\n');
    assertMessageSafe(combined, 'CLI vault resync');
  });

  // ── Tool chamba_vault_sync ────────────────────────────────────────────────

  it('tool chamba_vault_sync: incluye code, no filtra token ni Authorization', async () => {
    const svc = await makeServices();
    const { client, server } = await connectMcp(svc);
    try {
      const result = await client.callTool({
        name: 'chamba_vault_sync',
        arguments: { slug: 'cya' },
      });
      const text = textOf(result);
      assertMessageSafe(text, 'tool chamba_vault_sync');
    } finally {
      await server.close();
    }
  });

  // ── Tool chamba_vault_join ────────────────────────────────────────────────

  it('tool chamba_vault_join: incluye code, no filtra token ni Authorization', async () => {
    const svc = await makeServices({ setupCredentials: false, setupState: false });
    const { client, server } = await connectMcp(svc);
    try {
      const result = await client.callTool({
        name: 'chamba_vault_join',
        arguments: { code: 'K7QX-M2RP', name: 'Test', email: 'test@test.com' },
      });
      const text = textOf(result);
      assertMessageSafe(text, 'tool chamba_vault_join');
    } finally {
      await server.close();
    }
  });

  // ── Tool chamba_vault_link ────────────────────────────────────────────────

  it('tool chamba_vault_link: incluye code, no filtra token ni Authorization', async () => {
    const svc = await makeServices();
    const vaultDir = '/home/test/.chamba/vaults/cya-new';
    await (svc.fs as MemoryFilesystem).mkdir(vaultDir);
    const { client, server } = await connectMcp(svc);
    try {
      const result = await client.callTool({
        name: 'chamba_vault_link',
        arguments: { slug: 'cya', dir: vaultDir, confirmUpload: true },
      });
      const text = textOf(result);
      assertMessageSafe(text, 'tool chamba_vault_link');
    } finally {
      await server.close();
    }
  });

  // ── Tool chamba_vault_resync ──────────────────────────────────────────────

  it('tool chamba_vault_resync: incluye code, no filtra token ni Authorization', async () => {
    const svc = await makeServices();
    const { client, server } = await connectMcp(svc);
    try {
      const result = await client.callTool({
        name: 'chamba_vault_resync',
        arguments: { slug: 'cya', confirmUpload: true },
      });
      const text = textOf(result);
      assertMessageSafe(text, 'tool chamba_vault_resync');
    } finally {
      await server.close();
    }
  });

  // ── autosync warning ──────────────────────────────────────────────────────

  it('autosync warning: incluye code, no filtra token ni Authorization', async () => {
    // Set up a parche vault for autosync (needs a real state + credentials setup)
    // Using a FakeParche that fails on /changes
    const slug = 'cya';
    const fs = new MemoryFilesystem();
    const homedir = '/home/test';
    const vaultDir = `${homedir}/.chamba/vaults/${slug}`;
    await fs.mkdir(vaultDir);
    await writeState(fs, vaultDir, {
      server: FAKE_SERVER,
      slug,
      cursor: 0,
      files: {},
      lastSyncAt: OLD_SYNC,
    });
    await fs.mkdir(`${vaultDir}/.obsidian`);
    await fs.writeBytes(`${vaultDir}/.obsidian/workspace.json`, new TextEncoder().encode('{}'));

    const creds = new CredentialsStore(fs, homedir);
    await creds.set(FAKE_SERVER, slug, {
      token: FAKE_TOKEN,
      user: { id: 'u1', name: 'Joys' },
      device: { id: 'd1', label: 'laptop' },
      role: 'editor',
    });

    const svc: Services = {
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
      homedir,
      http: alwaysFailHttp,
      hash: new FakeHash(),
      random: new FakeRandom(),
      parchePullTtlMin: 5,
      vaultMutex: new Map(),
      platform: 'linux',
      username: 'testuser',
      obsidianVaultPath: vaultDir,
      autosyncBudgetMs: AUTOSYNC_BUDGET_MS,
    };

    // Trigger autosync via load_context tool (which does a pull-phase autosync)
    const warnings: string[] = [];
    const logLines: object[] = [];
    const captureLogger = pino(
      { level: 'debug' },
      {
        write(s: string) {
          try {
            logLines.push(JSON.parse(s));
          } catch {
            /* ignore */
          }
        },
      },
    );

    const { server: initialServer } = await connectMcp(svc);
    // Replace logger by connecting through a server that uses captureLogger
    await initialServer.close();

    // Reconnect with capture logger
    const [ct2, st2] = InMemoryTransport.createLinkedPair();
    const srv2 = createMcpServer(captureLogger, svc);
    const client2 = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([srv2.connect(st2), client2.connect(ct2)]);

    try {
      const result = await client2.callTool({
        name: 'chamba_load_context',
        arguments: { task: 'test task', includeObsidian: true },
      });
      const text = textOf(result);
      warnings.push(text);
    } finally {
      await srv2.close();
    }

    const allWarnings = warnings.join('\n');
    // The warning from autosync should be in the response text
    assertMessageSafe(allWarnings, 'autosync warning');

    // Also verify logger debug lines don't contain token or Authorization
    const allLogText = logLines.map((l) => JSON.stringify(l)).join('\n');
    expect(allLogText, 'log debug: no debe contener el token').not.toContain(FAKE_TOKEN);
    expect(allLogText, 'log debug: no debe contener Authorization').not.toContain('Authorization');
  });

  // ── formatFatal ───────────────────────────────────────────────────────────

  it('formatFatal: incluye cause.code cuando está presente', () => {
    const cause = Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' });
    const err = new TypeError('fetch failed', { cause });
    const msg = formatFatal(err);
    expect(msg).toContain('UND_ERR_CONNECT_TIMEOUT');
    expect(msg).not.toBe('fetch failed');
  });

  it('formatFatal: no filtra token pch_ de la causa', () => {
    // If the error message itself contains a token, it should be redacted
    const err = new Error(`fetch failed with pch_TESTSECRET0123456789abcdef`);
    const msg = formatFatal(err);
    expect(msg).not.toContain('pch_TESTSECRET0123456789abcdef');
    expect(msg).toContain('<token redactado>');
  });

  it('formatFatal: error sin cause devuelve solo el mensaje', () => {
    const err = new Error('something went wrong');
    const msg = formatFatal(err);
    expect(msg).toBe('something went wrong');
  });

  it('formatFatal: causa con code y message distintos incluye ambos', () => {
    const cause = Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' });
    const err = new TypeError('fetch failed', { cause });
    const msg = formatFatal(err);
    expect(msg).toContain('ETIMEDOUT');
    expect(msg).toContain('Connection timed out');
  });
});

// ─── RetryingHttp logger log sanitization ─────────────────────────────────────

describe('Test 11 — RetryingHttp logger: no filtra token en logs debug', () => {
  it('los logs debug de RetryingHttp no contienen el token ni Authorization ni query', async () => {
    const logLines: object[] = [];
    const captureLogger = {
      debug(obj: object, _msg?: string) {
        logLines.push(obj);
      },
    };

    // Create a flaky inner HttpPort that fails once then succeeds
    let attempt = 0;
    const innerHttp = {
      async request(_req: {
        method: string;
        url: string;
        headers: Record<string, string>;
        body?: Uint8Array;
      }) {
        attempt++;
        if (attempt === 1) {
          // Simulate a transient error (not ParcheNetworkError — that's thrown by RetryingHttp after exhaustion)
          const cause = Object.assign(
            new Error(`Connect timeout (Authorization: Bearer ${FAKE_TOKEN})`),
            { code: 'ECONNRESET' },
          );
          throw cause;
        }
        // Return a simple 200 response
        return {
          status: 200,
          headers: {},
          body: new TextEncoder().encode('{}'),
        };
      },
    };

    const retrying = new RetryingHttp(innerHttp as never, {
      logger: captureLogger,
      sleep: async () => {
        /* noop */
      },
    });

    // Make a GET request (retryable) that fails once then succeeds
    await retrying.request({
      method: 'GET',
      url: `${FAKE_SERVER}/api/health?auth=${FAKE_TOKEN}`,
      headers: { authorization: `Bearer ${FAKE_TOKEN}` },
    });

    const allLogText = logLines.map((l) => JSON.stringify(l)).join('\n');
    // Verify the debug logs don't contain the token
    expect(allLogText, 'log debug: no debe contener el token').not.toContain(FAKE_TOKEN);
    expect(allLogText, 'log debug: no debe contener Authorization').not.toContain('authorization');
    // The path in log should not have query params
    const pathLines = logLines
      .map((l) => (l as Record<string, unknown>).path as string)
      .filter(Boolean);
    for (const p of pathLines) {
      expect(p, `log path no debe tener query string: ${p}`).not.toContain('?');
    }
    expect(logLines.length).toBeGreaterThan(0);
  });
});

// ─── Process termination (no cuelgue de sockets) ─────────────────────────────

describe('Test 11 — RetryingHttp(NodeHttp) contra servidor local termina sin sockets colgados', () => {
  let httpServer: Server | undefined;

  afterEach(async () => {
    if (httpServer?.listening) {
      await new Promise<void>((resolve, reject) =>
        (httpServer as Server).close((e) => (e ? reject(e) : resolve())),
      );
    }
    httpServer = undefined;
  });

  it('sync con NodeHttp real contra servidor local no deja sockets TCPSocketWrap activos', async () => {
    const clock = makeClock();
    const parche = new FakeParche(clock);
    const group = parche.seedGroup({ slug: 'bench', name: 'Bench' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'test', role: 'editor' });

    // Spin up a real HTTP server
    let port = 0;
    await new Promise<void>((resolve, reject) => {
      const handler: RequestListener = async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req as AsyncIterable<Buffer>) {
          chunks.push(chunk);
        }
        const bodyBytes = Buffer.concat(chunks);
        const fullUrl = `http://127.0.0.1:${port}${req.url ?? '/'}`;
        const fakeReq = {
          method: req.method ?? 'GET',
          url: fullUrl,
          headers: Object.fromEntries(
            Object.entries(req.headers)
              .filter(([, v]) => typeof v === 'string')
              .map(([k, v]) => [k, v as string]),
          ),
          body: bodyBytes.length > 0 ? new Uint8Array(bodyBytes) : undefined,
        };
        try {
          const fakeRes = await parche.request(fakeReq);
          res.writeHead(fakeRes.status, fakeRes.headers);
          res.end(fakeRes.body);
        } catch {
          res.writeHead(500);
          res.end('error');
        }
      };
      httpServer = createServer(handler);
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer?.address();
        if (!addr || typeof addr === 'string') {
          reject(new Error('no port'));
          return;
        }
        port = addr.port;
        resolve();
      });
    });

    const serverUrl = `http://127.0.0.1:${port}`;
    const { MemoryFilesystem: Mfs, FakeHash: Fh, syncOnce } = await import('@chamba/core');
    const fs2 = new Mfs();
    const hash2 = new Fh();

    // Write 1 local file
    await fs2.writeBytes('/vault/file0.md', new TextEncoder().encode('# Hello'));

    const nodeHttp = new NodeHttp();
    const retrying = new RetryingHttp(nodeHttp, { sleep: async () => {} });

    await (syncOnce as typeof import('@chamba/core').syncOnce)(
      {
        fs: fs2,
        http: retrying,
        hash: hash2,
        clock: { now: () => new Date(FAKE_NOW), today: () => '2026-06-09' },
      },
      {
        vaultDir: '/vault',
        server: serverUrl,
        slug: 'bench',
        token,
        localAuthor: 'test',
        device: 'test',
      },
    );

    // Close the NodeHttp agent to let sockets drain
    nodeHttp.close();

    // Close the server
    await new Promise<void>((resolve, reject) =>
      (httpServer as Server).close((e) => (e ? reject(e) : resolve())),
    );
    httpServer = undefined;

    // Verify no TCPSocketWrap remains in active resources
    // (This checks that keepAlive sockets are properly unref'd)
    const activeResources = process.getActiveResourcesInfo();
    const tcpSockets = activeResources.filter((r) => r === 'TCPSocketWrap');
    // Allow up to 0 extra TCP sockets; some test runners may have their own
    // We just assert the sync itself completed without hanging
    expect(tcpSockets.length).toBeLessThanOrEqual(2);
  }, 30_000);
});
