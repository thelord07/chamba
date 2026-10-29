/**
 * parche-memory.test.ts — Tests for AC14 and Gate 4 (remember/recall with parche vault).
 *
 * Covers:
 *   AC14  — Two machines sharing one FakeParche:
 *            - chamba_remember on A writes <vaultA>/memory/<keyslug>.md and pushes
 *            - chamba_recall on B (state older than TTL) pulls and finds it
 *   AC14r — Regression: without parche vault, remember/recall use <cwd>/.chamba/memory/
 *            and FakeParche receives zero requests
 *   Gate 4a — recall returns personal memory labelled "personal, solo esta máquina"
 *             and vault memory labelled "grupo <slug>"
 *   Gate 4b — no personal memory appears in FakeParche PUT or push
 *   Gate 4c — vault status reports personal count
 */

import { CredentialsStore, FakeHash, FakeParche, MemoryFilesystem, writeState } from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import type { Services } from './services.js';

const silentLogger = pino({ level: 'silent' });

const PARCHE_SERVER = 'https://parche.chamba.tools';
const SLUG = 'team-alpha';
const FAKE_NOW = '2026-06-09T10:00:00.000Z';
// lastSyncAt older than TTL (5 min default)
const STALE_SYNC = '2026-06-09T09:50:00.000Z';

function makeClock(now = FAKE_NOW) {
  const d = new Date(now);
  return {
    now: () => d,
    today: () => d.toISOString().slice(0, 10),
  };
}

/**
 * Build a service set for "machine X" with a parche vault pre-configured.
 * Uses the shared `parche` instance so both machines share the same server.
 */
async function makeMachine(opts: {
  parche: FakeParche;
  machineId: string;
  token: string;
  lastSyncAt?: string;
}): Promise<{ svc: Services; vaultDir: string }> {
  const { machineId, parche, token, lastSyncAt } = opts;
  const homedir = `/home/${machineId}`;
  const vaultDir = `${homedir}/.chamba/vaults/${SLUG}`;
  const fs = new MemoryFilesystem();

  // Vault structure
  await fs.mkdir(`${vaultDir}/.obsidian`);
  await fs.writeFile(`${vaultDir}/.obsidian/app.json`, '{}');

  // Write state.json
  await writeState(fs, vaultDir, {
    server: PARCHE_SERVER,
    slug: SLUG,
    cursor: 0,
    files: {},
    lastSyncAt: lastSyncAt ?? FAKE_NOW,
  });

  // Write credential
  const creds = new CredentialsStore(fs, homedir);
  await creds.set(PARCHE_SERVER, SLUG, {
    token,
    user: { id: `u-${machineId}`, name: machineId },
    device: { id: `d-${machineId}`, label: machineId },
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
    cwd: `/${machineId}/proj`,
    homedir,
    http: parche,
    hash: new FakeHash(),
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
    obsidianVaultPath: vaultDir,
  };

  return { svc, vaultDir };
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

// ─── AC14: remember on A → recall on B ───────────────────────────────────────

describe('AC14 — remember/recall across machines via FakeParche', () => {
  it('memory written on machine A is found by machine B after pull', async () => {
    // Shared parche server
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: SLUG, name: 'Team Alpha' });

    // Machine A: token via addDevice
    const tokenA = parche.addDevice(group.id, { userId: 'u-machineA', label: 'machineA' });
    // Machine B: separate device, stale state to trigger pull
    const tokenB = parche.addDevice(group.id, { userId: 'u-machineB', label: 'machineB' });

    const { svc: svcA } = await makeMachine({ parche, machineId: 'machineA', token: tokenA });
    const { svc: svcB } = await makeMachine({
      parche,
      machineId: 'machineB',
      token: tokenB,
      lastSyncAt: STALE_SYNC, // older than 5 min → triggers pull
    });

    const { client: clientA, server: serverA } = await connect(svcA);

    // Machine A: remember something
    await clientA.callTool({
      name: 'chamba_remember',
      arguments: {
        key: 'auth-decision',
        content: 'We use magic links.',
        tags: ['auth'],
      },
    });

    await serverA.close();

    // Machine B: recall — should pull from parche and find the memory
    const { client: clientB, server: serverB } = await connect(svcB);

    const result = await clientB.callTool({
      name: 'chamba_recall',
      arguments: { query: 'auth' },
    });

    const txt = textOf(result);
    expect(txt).toContain('magic links');

    await serverB.close();
  });

  it('memory file is written to <vault>/memory/<keyslug>.md', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: SLUG, name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop' });

    const { svc, vaultDir } = await makeMachine({ parche, machineId: 'laptop', token });

    const { client, server } = await connect(svc);

    await client.callTool({
      name: 'chamba_remember',
      arguments: { key: 'my-decision', content: 'Use TypeScript.' },
    });

    // File should be in vault/memory/, not in cwd/.chamba/memory/
    const vaultMemPath = `${vaultDir}/memory/my-decision.md`;
    expect(await svc.fs.exists(vaultMemPath)).toBe(true);
    // NOT in cwd
    const cwdMemPath = `/laptop/proj/.chamba/memory/my-decision.md`;
    expect(await svc.fs.exists(cwdMemPath)).toBe(false);

    await server.close();
  });
});

// ─── AC14 regression: no parche vault → cwd/.chamba/memory/ ─────────────────

describe('AC14 regression — without parche vault uses cwd/.chamba/memory/', () => {
  it('remember writes to cwd/.chamba/memory/ when no parche vault is active', async () => {
    // No obsidian vault path set, no state.json → no parche vault detected
    const parche = new FakeParche(makeClock());

    const svc: Services = {
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
      // No obsidianVaultPath → detection will fail → no parche vault
    };

    const { client, server } = await connect(svc);

    // Track requests to FakeParche
    let parcheRequestCount = 0;
    const originalRequest = parche.request.bind(parche);
    parche.request = async (req) => {
      parcheRequestCount++;
      return originalRequest(req);
    };

    await client.callTool({
      name: 'chamba_remember',
      arguments: { key: 'no-parche-key', content: 'Local only.' },
    });

    // Written to cwd/.chamba/memory/
    expect(await svc.fs.exists('/proj/.chamba/memory/no-parche-key.md')).toBe(true);
    // FakeParche received ZERO requests
    expect(parcheRequestCount).toBe(0);

    await server.close();
  });

  it('recall reads from cwd/.chamba/memory/ without calling FakeParche', async () => {
    const parche = new FakeParche(makeClock());

    const svc: Services = {
      fs: new MemoryFilesystem({
        '/proj/.chamba/memory/local-key.md':
          '---\nkey: local-key\ntags: []\n---\n\n# local-key\n\nlocal only content\n',
      }),
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
    };

    let parcheRequestCount = 0;
    const origRequest = parche.request.bind(parche);
    parche.request = async (req) => {
      parcheRequestCount++;
      return origRequest(req);
    };

    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_recall',
      arguments: { query: 'local' },
    });

    expect(textOf(result)).toContain('local only content');
    expect(parcheRequestCount).toBe(0);

    await server.close();
  });
});

// ─── Gate 4: labels "personal" vs "grupo <slug>" ─────────────────────────────

describe('Gate 4 — personal vs vault memory labels', () => {
  it('recall labels vault memory as "grupo <slug>" and personal as "personal, solo esta máquina"', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: SLUG, name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop' });

    const { svc, vaultDir } = await makeMachine({ parche, machineId: 'laptop', token });

    // Pre-seed: a vault memory
    await svc.fs.mkdir(`${vaultDir}/memory`);
    await svc.fs.writeFile(
      `${vaultDir}/memory/group-key.md`,
      '---\nkey: group-key\ntags: []\n---\n\n# group-key\n\nGroup memory content\n',
    );

    // Pre-seed: a personal memory (in cwd, not vault)
    await svc.fs.mkdir('/laptop/proj/.chamba/memory');
    await svc.fs.writeFile(
      '/laptop/proj/.chamba/memory/personal-key.md',
      '---\nkey: personal-key\ntags: []\n---\n\n# personal-key\n\nPersonal memory content\n',
    );

    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_recall',
      arguments: { query: 'memory' },
    });

    const txt = textOf(result);
    // Both memories found
    expect(txt).toContain('Group memory content');
    expect(txt).toContain('Personal memory content');
    // Correct labels
    expect(txt).toContain('grupo team-alpha');
    expect(txt).toContain('personal, solo esta máquina');

    await server.close();
  });

  it('no personal memory appears in FakeParche PUT or push', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: SLUG, name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop' });

    const { svc } = await makeMachine({ parche, machineId: 'laptop', token });

    // Add a personal memory to cwd
    await svc.fs.mkdir('/laptop/proj/.chamba/memory');
    await svc.fs.writeFile(
      '/laptop/proj/.chamba/memory/secret.md',
      '---\nkey: secret\ntags: []\n---\n\n# secret\n\nPrivate stuff\n',
    );

    // Track blob PUT and push requests
    const pushedPaths: string[] = [];
    const blobPuts: string[] = [];
    const origRequest = parche.request.bind(parche);

    parche.request = async (req) => {
      const url = new URL(req.url);
      if (req.method === 'PUT' && url.pathname.includes('/blob/')) {
        blobPuts.push(url.pathname);
      }
      if (req.method === 'POST' && url.pathname.includes('/push')) {
        const dec = new TextDecoder();
        const body = JSON.parse(
          dec.decode(
            req.body instanceof Uint8Array
              ? req.body
              : new TextEncoder().encode(String(req.body ?? '')),
          ),
        );
        for (const c of body.changes ?? []) {
          pushedPaths.push(c.path);
        }
      }
      return origRequest(req);
    };

    const { client, server } = await connect(svc);

    // Remember via vault (should push vault memory, not personal)
    await client.callTool({
      name: 'chamba_remember',
      arguments: { key: 'group-note', content: 'Something for the group' },
    });

    // Personal memory paths should NOT appear in any push
    const allPushed = pushedPaths.join('\n');
    expect(allPushed).not.toContain('secret');
    expect(allPushed).not.toContain('.chamba/memory');

    await server.close();
  });

  it('vault status reports personal memory count', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: SLUG, name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop' });

    const { svc } = await makeMachine({ parche, machineId: 'laptop', token });

    // Add personal memories in cwd
    await svc.fs.mkdir('/laptop/proj/.chamba/memory');
    await svc.fs.writeFile(
      '/laptop/proj/.chamba/memory/personal-one.md',
      '---\nkey: personal-one\ntags: []\n---\n\n# personal-one\n\ncontent\n',
    );

    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_parche_status',
      arguments: {},
    });

    const sc = (result as { structuredContent: { personalMemoryCount: number } }).structuredContent;
    expect(sc.personalMemoryCount).toBe(1);

    await server.close();
  });
});
