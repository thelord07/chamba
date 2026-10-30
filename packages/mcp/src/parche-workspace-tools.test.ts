/**
 * parche-workspace-tools.test.ts — PARCHE-011 MCP tool tests for workspace-scoped parche.
 *
 * Covers:
 *   AC2  — two Services with different workspace slugs: remember writes to own vault,
 *           pushes only to own parche server, other server gets 0 pushes
 *   AC5  — env vault path set to another dir → tools read/write workspace vault, env dir untouched
 *   AC6  — autoSync.enabled:false → remember/summarize/load_context/recall → 0 FakeParche requests
 *           but still writes/reads the binding vault
 *   O2   — causes: no-cred / pending-adoption / dir-missing / cred-binding divergence:
 *           tool returns normal + warning with fix command; dir missing → isError + no file
 *   O3   — CHAMBA_WORKSPACE_ROOT (services.workspaceRoot) pointing at wsB while cwd in wsA
 *           → wsB's binding used; chamba_vault_status shows workspace, source env, binding
 *   R8   — workspace_init leaves existing .chamba/parche.json byte-identical
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
const FAKE_NOW = '2026-06-09T10:00:00.000Z';
const OLD_SYNC = '2026-06-09T09:50:00.000Z'; // > 5 min ago

function makeClock(now = FAKE_NOW) {
  const d = new Date(now);
  return { now: () => d, today: () => d.toISOString().slice(0, 10) };
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.map((c) => c.text).join('\n');
}

function structuredOf(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent ?? {};
}

async function connect(svc: Services) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer(silentLogger, svc);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

/**
 * Build services with a workspace-scoped parche binding.
 * workspaceRoot MUST be inside homedir (findWorkspaceRoot depth heuristic).
 * wsRoot defaults to `${homedir}/Projects/workspace`.
 */
async function makeWorkspaceSvc(opts: {
  parche: FakeParche;
  wsRoot?: string;
  homedir: string;
  slug: string;
  token: string;
  autoSyncEnabled?: boolean;
  lastSyncAt?: string;
  workspaceRootOverride?: string;
}): Promise<{ svc: Services; vaultDir: string; wsRoot: string }> {
  const wsRoot = opts.wsRoot ?? `${opts.homedir}/Projects/workspace`;
  const { parche, homedir, slug, token, autoSyncEnabled = true, lastSyncAt = OLD_SYNC } = opts;
  const vaultDir = `${wsRoot}/vault`;
  const fs = new MemoryFilesystem();

  // Workspace marker
  await fs.mkdir(`${wsRoot}/.chamba`);
  await fs.writeFile(`${wsRoot}/.chamba/workspace.md`, '# Workspace\n');

  // Workspace parche.json
  await fs.writeFile(
    `${wsRoot}/.chamba/parche.json`,
    JSON.stringify({
      version: 1,
      server: PARCHE_SERVER,
      slug,
      vaultDir: 'vault',
      autoSync: { enabled: autoSyncEnabled, pullTtlMin: 5 },
    }),
  );

  // Vault dir
  await fs.mkdir(`${vaultDir}/.obsidian`);
  await fs.writeFile(`${vaultDir}/.obsidian/app.json`, '{}');

  // Write state.json
  await writeState(fs, vaultDir, {
    server: PARCHE_SERVER,
    slug,
    cursor: 0,
    files: {},
    lastSyncAt,
  });

  // Write credential — set dir explicitly to match the binding vaultDir
  // so resolveVaultDir(cred) → vaultDir → no realpath mismatch
  const creds = new CredentialsStore(fs, homedir);
  await creds.set(PARCHE_SERVER, slug, {
    token,
    user: { id: `u-${slug}`, name: slug },
    device: { id: `d-${slug}`, label: `device-${slug}` },
    role: 'editor',
    dir: vaultDir,
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
    cwd: wsRoot,
    homedir,
    http: parche,
    hash: new FakeHash(),
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
    workspaceRoot: opts.workspaceRootOverride,
  };

  return { svc, vaultDir, wsRoot };
}

// ─── AC2: two workspaces on same machine, different slugs, don't cross ───────

describe('AC2 — workspace isolation (same machine, shared credentials.json)', () => {
  it('remember writes to own vault and pushes only to own parche, other has 0 pushes', async () => {
    // Real scenario: single machine, single homedir, two workspace bindings
    // Each workspace points at a different FakeParche (simulating distinct servers/groups)
    const homedir = '/home/test';

    const parcheA = new FakeParche(makeClock());
    const groupA = parcheA.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    const tokenA = parcheA.addDevice(groupA.id, { userId: 'u-a', label: 'deviceA' });

    const parcheB = new FakeParche(makeClock());
    const groupB = parcheB.seedGroup({ slug: 'team-beta', name: 'Team Beta' });
    const tokenB = parcheB.addDevice(groupB.id, { userId: 'u-b', label: 'deviceB' });

    // Both workspaces on the same filesystem (same homedir → same credentials.json)
    const wsA = `${homedir}/Projects/wsA`;
    const wsB = `${homedir}/Projects/wsB`;
    const fs = new MemoryFilesystem();

    // wsA setup — binds team-alpha on parcheA
    await fs.mkdir(`${wsA}/.chamba`);
    await fs.writeFile(`${wsA}/.chamba/workspace.md`, '# wsA\n');
    await fs.writeFile(
      `${wsA}/.chamba/parche.json`,
      JSON.stringify({
        version: 1,
        server: PARCHE_SERVER,
        slug: 'team-alpha',
        vaultDir: 'vault',
        autoSync: { enabled: true, pullTtlMin: 5 },
      }),
    );
    const vaultA = `${wsA}/vault`;
    await fs.mkdir(`${vaultA}/.obsidian`);
    await fs.writeFile(`${vaultA}/.obsidian/app.json`, '{}');
    await writeState(fs, vaultA, {
      server: PARCHE_SERVER,
      slug: 'team-alpha',
      cursor: 0,
      files: {},
      lastSyncAt: OLD_SYNC,
    });

    // wsB setup — binds team-beta on parcheB
    await fs.mkdir(`${wsB}/.chamba`);
    await fs.writeFile(`${wsB}/.chamba/workspace.md`, '# wsB\n');
    await fs.writeFile(
      `${wsB}/.chamba/parche.json`,
      JSON.stringify({
        version: 1,
        server: PARCHE_SERVER,
        slug: 'team-beta',
        vaultDir: 'vault',
        autoSync: { enabled: true, pullTtlMin: 5 },
      }),
    );
    const vaultB = `${wsB}/vault`;
    await fs.mkdir(`${vaultB}/.obsidian`);
    await fs.writeFile(`${vaultB}/.obsidian/app.json`, '{}');
    await writeState(fs, vaultB, {
      server: PARCHE_SERVER,
      slug: 'team-beta',
      cursor: 0,
      files: {},
      lastSyncAt: OLD_SYNC,
    });

    // Both credentials in the SAME credentials.json
    const creds = new CredentialsStore(fs, homedir);
    await creds.set(PARCHE_SERVER, 'team-alpha', {
      token: tokenA,
      user: { id: 'u-a', name: 'Alpha' },
      device: { id: 'd-a', label: 'deviceA' },
      role: 'editor',
      dir: vaultA,
    });
    await creds.set(PARCHE_SERVER, 'team-beta', {
      token: tokenB,
      user: { id: 'u-b', name: 'Beta' },
      device: { id: 'd-b', label: 'deviceB' },
      role: 'editor',
      dir: vaultB,
    });

    // svcA is cwd=wsA, http=parcheA
    const svcA: Services = {
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
      cwd: wsA,
      homedir,
      http: parcheA,
      hash: new FakeHash(),
      parchePullTtlMin: 5,
      vaultMutex: new Map(),
    };

    const { client: clientA, server: serverA } = await connect(svcA);

    await clientA.callTool({
      name: 'chamba_remember',
      arguments: { key: 'my-note', content: 'Hello from wsA' },
    });

    // memory file written to wsA's vault
    expect(await fs.exists(`${vaultA}/memory`)).toBe(true);
    // wsB's vault untouched
    expect(await fs.exists(`${vaultB}/memory`)).toBe(false);
    // parcheB received 0 requests
    expect(
      parcheB.requestLog.filter((r) => r.method === 'POST' && r.url.includes('push')),
    ).toHaveLength(0);

    await serverA.close();
  });
});

// ─── AC5: env vault path is ignored when workspace binding exists ─────────────

describe('AC5 — env vault path untouched when workspace binding exists', () => {
  it('remember writes to binding vault, env vault dir gets no new files', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'device' });

    const homedir = '/home/test';
    const { svc, vaultDir } = await makeWorkspaceSvc({
      parche,
      homedir,
      slug: 'team-alpha',
      token,
    });

    // Set env vault path to another location (also inside homedir for realism)
    const envVaultDir = `${homedir}/other-obsidian-vault`;
    await svc.fs.mkdir(`${envVaultDir}/.obsidian`);
    await svc.fs.writeFile(`${envVaultDir}/.obsidian/app.json`, '{}');
    svc.obsidianVaultPath = envVaultDir;

    const { client, server } = await connect(svc);

    await client.callTool({
      name: 'chamba_remember',
      arguments: { key: 'test-key', content: 'test content' },
    });

    // Memory file is in binding vault
    const bindingMemory = await svc.fs.exists(`${vaultDir}/memory`);
    expect(bindingMemory).toBe(true);

    // Env vault dir has no new memory files
    const envMemory = await svc.fs.exists(`${envVaultDir}/memory`);
    expect(envMemory).toBe(false);

    await server.close();
  });
});

// ─── AC6: autoSync.enabled:false → 0 requests, still reads/writes vault ──────

describe('AC6 — autoSync.enabled:false', () => {
  it('remember produces 0 FakeParche requests but writes to binding vault', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'device' });

    const { svc, vaultDir } = await makeWorkspaceSvc({
      parche,
      homedir: '/home/test',
      slug: 'team-alpha',
      token,
      autoSyncEnabled: false,
    });

    const requestsBefore = parche.requestLog.length;
    const { client, server } = await connect(svc);

    await client.callTool({
      name: 'chamba_remember',
      arguments: { key: 'test-key', content: 'content' },
    });

    // 0 new FakeParche requests (no push, no pull)
    expect(parche.requestLog.length).toBe(requestsBefore);

    // Still writes to binding vault
    const hasMemory = await svc.fs.exists(`${vaultDir}/memory`);
    expect(hasMemory).toBe(true);

    await server.close();
  });

  it('load_context produces 0 FakeParche requests when autoSync:false', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'device' });

    const { svc } = await makeWorkspaceSvc({
      parche,
      homedir: '/home/test',
      slug: 'team-alpha',
      token,
      autoSyncEnabled: false,
    });

    const requestsBefore = parche.requestLog.length;
    const { client, server } = await connect(svc);

    await client.callTool({
      name: 'chamba_load_context',
      arguments: { task: 'test task' },
    });

    expect(parche.requestLog.length).toBe(requestsBefore);
    await server.close();
  });

  it('recall produces 0 FakeParche requests when autoSync:false', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'device' });

    const { svc } = await makeWorkspaceSvc({
      parche,
      homedir: '/home/test',
      slug: 'team-alpha',
      token,
      autoSyncEnabled: false,
    });

    const requestsBefore = parche.requestLog.length;
    const { client, server } = await connect(svc);

    await client.callTool({
      name: 'chamba_recall',
      arguments: { query: 'test query' },
    });

    expect(parche.requestLog.length).toBe(requestsBefore);
    await server.close();
  });
});

// ─── O2: bound-unsyncable causes ─────────────────────────────────────────────

describe('O2 — bound-unsyncable: warning line with fix command', () => {
  it('no credential → remember returns normal text + warning with fix command', async () => {
    const parche = new FakeParche(makeClock());
    const fs = new MemoryFilesystem();
    const homedir = '/home/test';
    const wsRoot = `${homedir}/Projects/my-ws`;
    const vaultDir = `${wsRoot}/vault`;

    // Workspace binding but NO credential
    await fs.mkdir(`${wsRoot}/.chamba`);
    await fs.writeFile(`${wsRoot}/.chamba/workspace.md`, '# WS\n');
    await fs.writeFile(
      `${wsRoot}/.chamba/parche.json`,
      JSON.stringify({ version: 1, server: PARCHE_SERVER, slug: 'team-alpha', vaultDir: 'vault' }),
    );
    // Create vault dir (so bound-unsyncable with dirExists=true)
    await fs.mkdir(`${vaultDir}/.obsidian`);
    await fs.writeFile(`${vaultDir}/.obsidian/app.json`, '{}');
    await writeState(fs, vaultDir, {
      server: PARCHE_SERVER,
      slug: 'team-alpha',
      cursor: 0,
      files: {},
      lastSyncAt: FAKE_NOW,
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
      cwd: wsRoot,
      homedir,
      http: parche,
      hash: new FakeHash(),
      parchePullTtlMin: 5,
      vaultMutex: new Map(),
    };

    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_remember',
      arguments: { key: 'test', content: 'hello' },
    });

    const text = textOf(result);
    // O2: no-cred but dir EXISTS → tool responds normally and writes there, with warning.
    expect(text).toContain('npx @chamba/mcp vault');
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    // Memory file should be written to the vault dir
    expect(await svc.fs.exists(`${vaultDir}/memory`)).toBe(true);

    await server.close();
  });

  it('dir missing → remember returns isError + no file written', async () => {
    const parche = new FakeParche(makeClock());
    const fs = new MemoryFilesystem();
    const homedir = '/home/test';
    const wsRoot = `${homedir}/Projects/my-ws`;

    // Workspace binding + credential but NO vault dir
    await fs.mkdir(`${wsRoot}/.chamba`);
    await fs.writeFile(`${wsRoot}/.chamba/workspace.md`, '# WS\n');
    await fs.writeFile(
      `${wsRoot}/.chamba/parche.json`,
      JSON.stringify({ version: 1, server: PARCHE_SERVER, slug: 'team-alpha', vaultDir: 'vault' }),
    );

    const creds = new CredentialsStore(fs, homedir);
    await creds.set(PARCHE_SERVER, 'team-alpha', {
      token: 'pch_fake_test',
      user: { id: 'u1', name: 'Test' },
      device: { id: 'd1', label: 'laptop' },
      role: 'editor',
    });
    // Do NOT create the vault dir

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
      cwd: wsRoot,
      homedir,
      http: parche,
      hash: new FakeHash(),
      parchePullTtlMin: 5,
      vaultMutex: new Map(),
    };

    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_remember',
      arguments: { key: 'test', content: 'hello' },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    // No file anywhere in the default vault or the binding vault
    expect(await svc.fs.exists(`${homedir}/.chamba/vaults/team-alpha/memory`)).toBe(false);
    expect(await svc.fs.exists(`${wsRoot}/vault/memory`)).toBe(false);

    await server.close();
  });
});

// ─── O3: CHAMBA_WORKSPACE_ROOT override ──────────────────────────────────────

describe('O3 — CHAMBA_WORKSPACE_ROOT (services.workspaceRoot) override', () => {
  it('workspaceRoot pointing at wsB while cwd in wsA → wsB binding used', async () => {
    const parcheA = new FakeParche(makeClock());
    const groupA = parcheA.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parcheA.addDevice(groupA.id, { userId: 'u-a' });

    const parcheB = new FakeParche(makeClock());
    const groupB = parcheB.seedGroup({ slug: 'team-beta', name: 'Team Beta' });
    const tokenB = parcheB.addDevice(groupB.id, { userId: 'u-b', label: 'deviceB' });

    // We need both workspaces on the SAME fs for simplicity
    const fs = new MemoryFilesystem();
    const homedir = '/home/test';

    // wsA and wsB must be inside homedir for findWorkspaceRoot to work
    const wsA = `${homedir}/Projects/wsA`;
    const wsB = `${homedir}/Projects/wsB`;

    // wsA setup
    await fs.mkdir(`${wsA}/.chamba`);
    await fs.writeFile(`${wsA}/.chamba/workspace.md`, '# wsA\n');
    await fs.writeFile(
      `${wsA}/.chamba/parche.json`,
      JSON.stringify({
        version: 1,
        server: PARCHE_SERVER,
        slug: 'team-alpha',
        vaultDir: 'vault',
        autoSync: { enabled: true, pullTtlMin: 5 },
      }),
    );
    await fs.mkdir(`${wsA}/vault/.obsidian`);
    await fs.writeFile(`${wsA}/vault/.obsidian/app.json`, '{}');
    await writeState(fs, `${wsA}/vault`, {
      server: PARCHE_SERVER,
      slug: 'team-alpha',
      cursor: 0,
      files: {},
      lastSyncAt: FAKE_NOW,
    });

    // wsB setup
    await fs.mkdir(`${wsB}/.chamba`);
    await fs.writeFile(`${wsB}/.chamba/workspace.md`, '# wsB\n');
    await fs.writeFile(
      `${wsB}/.chamba/parche.json`,
      JSON.stringify({
        version: 1,
        server: PARCHE_SERVER,
        slug: 'team-beta',
        vaultDir: 'vault',
        autoSync: { enabled: true, pullTtlMin: 5 },
      }),
    );
    await fs.mkdir(`${wsB}/vault/.obsidian`);
    await fs.writeFile(`${wsB}/vault/.obsidian/app.json`, '{}');
    await writeState(fs, `${wsB}/vault`, {
      server: PARCHE_SERVER,
      slug: 'team-beta',
      cursor: 0,
      files: {},
      lastSyncAt: FAKE_NOW,
    });

    // Credentials for team-beta only
    const creds = new CredentialsStore(fs, homedir);
    await creds.set(PARCHE_SERVER, 'team-beta', {
      token: tokenB,
      user: { id: 'u-b', name: 'Test B' },
      device: { id: 'd-b', label: 'device-b' },
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
      cwd: wsA, // cwd is in wsA
      homedir,
      http: parcheB, // Use parcheB since it has team-beta credentials
      hash: new FakeHash(),
      parchePullTtlMin: 5,
      vaultMutex: new Map(),
      workspaceRoot: wsB, // but workspaceRoot override points to wsB
    };

    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_status',
      arguments: {},
    });

    const text = textOf(result);
    // Should show wsB workspace, not wsA
    expect(text).toContain('wsB');
    expect(text).toContain('team-beta');

    const sc = structuredOf(result);
    const binding = sc.binding as { slug: string; scope: string } | null | undefined;
    expect(binding?.slug).toBe('team-beta');

    await server.close();
  });

  it('chamba_vault_status shows workspace, source env, binding', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'device' });

    const homedir = '/home/test';
    const wsRoot = `${homedir}/Projects/workspace`;
    const { svc } = await makeWorkspaceSvc({
      parche,
      wsRoot,
      homedir,
      slug: 'team-alpha',
      token,
      workspaceRootOverride: wsRoot,
    });

    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_status',
      arguments: {},
    });

    const text = textOf(result);
    const sc = structuredOf(result);

    // Must show workspace root and source
    expect(text).toContain('workspace');
    // Binding must be present
    const binding = sc.binding as Record<string, unknown> | null | undefined;
    expect(binding?.slug).toBe('team-alpha');

    await server.close();
  });
});

// ─── R8: workspace_init leaves parche.json byte-identical ────────────────────

describe('R8 — workspace_init leaves existing parche.json byte-identical', () => {
  it('parche.json is not touched by workspace_init', async () => {
    const parche = new FakeParche(makeClock());
    const fs = new MemoryFilesystem();
    const wsRoot = '/home/test/Projects/workspace';
    const parcheContent = JSON.stringify(
      {
        version: 1,
        server: PARCHE_SERVER,
        slug: 'team-alpha',
        vaultDir: 'vault',
        autoSync: { enabled: true, pullTtlMin: 5 },
      },
      null,
      2,
    );

    await fs.mkdir(`${wsRoot}/.chamba`);
    await fs.writeFile(`${wsRoot}/.chamba/workspace.md`, '# Workspace\n');
    await fs.writeFile(`${wsRoot}/.chamba/parche.json`, parcheContent);

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
      cwd: wsRoot,
      homedir: '/home/test',
      http: parche,
      hash: new FakeHash(),
      parchePullTtlMin: 5,
      vaultMutex: new Map(),
    };

    const { client, server } = await connect(svc);

    await client.callTool({
      name: 'chamba_workspace_init',
      arguments: { root: wsRoot, createVault: false },
    });

    // parche.json must be byte-identical
    const after = await fs.readFile(`${wsRoot}/.chamba/parche.json`);
    expect(after).toBe(parcheContent);

    await server.close();
  });
});

// ─── R2: summarize_to_vault and save_plan write to binding vault ───────────────

describe('R2 — summarize_to_vault and save_plan use binding vault, not env', () => {
  it('summarize_to_vault writes to binding vault, env vault dir untouched', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'device' });
    const homedir = '/home/test';
    const { svc, vaultDir } = await makeWorkspaceSvc({
      parche,
      homedir,
      slug: 'team-alpha',
      token,
    });

    const envVault = `${homedir}/env-vault`;
    await svc.fs.mkdir(`${envVault}/.obsidian`);
    await svc.fs.writeFile(`${envVault}/.obsidian/app.json`, '{}');
    svc.obsidianVaultPath = envVault;

    const { client, server } = await connect(svc);

    await client.callTool({
      name: 'chamba_summarize_to_vault',
      arguments: { title: 'Test Summary', content: '## Body\nContent here.' },
    });

    expect(await svc.fs.exists(`${vaultDir}/proyectos`)).toBe(true);
    expect(await svc.fs.exists(`${envVault}/proyectos`)).toBe(false);

    await server.close();
  });

  it('save_plan writes to <binding vault>/plans/', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'device' });
    const homedir = '/home/test';
    const { svc, vaultDir } = await makeWorkspaceSvc({
      parche,
      homedir,
      slug: 'team-alpha',
      token,
    });

    const { client, server } = await connect(svc);

    await client.callTool({
      name: 'chamba_save_plan',
      arguments: { title: 'My Plan', content: '## Goal\nDo the thing.' },
    });

    expect(await svc.fs.exists(`${vaultDir}/plans`)).toBe(true);

    await server.close();
  });

  it('recall reads from binding vault, env vault memory is ignored', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'device' });
    const homedir = '/home/test';
    const { svc, vaultDir } = await makeWorkspaceSvc({
      parche,
      homedir,
      slug: 'team-alpha',
      token,
    });

    await svc.fs.mkdir(`${vaultDir}/memory`);
    await svc.fs.writeFile(
      `${vaultDir}/memory/binding-key.md`,
      '---\nkey: binding-key\ntags: []\n---\nxbind99',
    );

    const envVault = `${homedir}/env-vault`;
    await svc.fs.mkdir(`${envVault}/.obsidian`);
    await svc.fs.writeFile(`${envVault}/.obsidian/app.json`, '{}');
    await svc.fs.mkdir(`${envVault}/memory`);
    await svc.fs.writeFile(
      `${envVault}/memory/env-key.md`,
      '---\nkey: env-key\ntags: []\n---\nxenv99',
    );
    svc.obsidianVaultPath = envVault;

    const { client, server } = await connect(svc);

    const resultBinding = await client.callTool({
      name: 'chamba_recall',
      arguments: { query: 'xbind99' },
    });
    expect(textOf(resultBinding)).toContain('xbind99');

    // Verify env vault memory is NOT returned: check structured matches are empty
    // (the text may still contain the query string in the "No memories matched" message)
    const resultEnv = await client.callTool({
      name: 'chamba_recall',
      arguments: { query: 'xenv99' },
    });
    const scEnv = (resultEnv as { structuredContent?: { matches?: unknown[] } }).structuredContent;
    // 0 matches from env vault (binding vault wins, env vault is not consulted)
    expect(scEnv?.matches).toHaveLength(0);

    await server.close();
  });
});

// ─── R7: save_plan pushes after writing ──────────────────────────────────────

describe('R7 — save_plan pushes after writing when autoSync:true', () => {
  it('save_plan produces a push request after writing to binding vault', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'device' });
    const homedir = '/home/test';
    const { svc, vaultDir } = await makeWorkspaceSvc({
      parche,
      homedir,
      slug: 'team-alpha',
      token,
    });

    const requestsBefore = parche.requestLog.length;
    const { client, server } = await connect(svc);

    await client.callTool({
      name: 'chamba_save_plan',
      arguments: { title: 'My Plan', content: '## Goal\nDo the thing.' },
    });

    expect(await svc.fs.exists(`${vaultDir}/plans`)).toBe(true);
    const pushes = parche.requestLog
      .slice(requestsBefore)
      .filter((r) => r.method === 'POST' && r.url.includes('push'));
    expect(pushes.length).toBeGreaterThan(0);

    await server.close();
  });
});

// ─── AC6 extended: summarize_to_vault and save_plan respect autoSync:false ───

describe('AC6 extended — summarize and save_plan skip sync when autoSync:false', () => {
  it('summarize_to_vault produces 0 FakeParche requests when autoSync:false', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'device' });
    const { svc, vaultDir } = await makeWorkspaceSvc({
      parche,
      homedir: '/home/test',
      slug: 'team-alpha',
      token,
      autoSyncEnabled: false,
    });

    const requestsBefore = parche.requestLog.length;
    const { client, server } = await connect(svc);

    await client.callTool({
      name: 'chamba_summarize_to_vault',
      arguments: { title: 'No-sync summary', content: '## Body\nContent.' },
    });

    expect(parche.requestLog.length).toBe(requestsBefore);
    expect(await svc.fs.exists(`${vaultDir}/proyectos`)).toBe(true);

    await server.close();
  });

  it('save_plan produces 0 FakeParche requests when autoSync:false', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'device' });
    const { svc, vaultDir } = await makeWorkspaceSvc({
      parche,
      homedir: '/home/test',
      slug: 'team-alpha',
      token,
      autoSyncEnabled: false,
    });

    const requestsBefore = parche.requestLog.length;
    const { client, server } = await connect(svc);

    await client.callTool({
      name: 'chamba_save_plan',
      arguments: { title: 'No-sync plan', content: '## Goal\nDo it.' },
    });

    expect(parche.requestLog.length).toBe(requestsBefore);
    expect(await svc.fs.exists(`${vaultDir}/plans`)).toBe(true);

    await server.close();
  });
});

// ─── O2 additional causes ─────────────────────────────────────────────────────

describe('O2 additional — pending-adoption and realpath-mismatch', () => {
  it('pending-adoption + dir exists → remember writes normally with warning, 0 sync', async () => {
    const parche = new FakeParche(makeClock());
    const homedir = '/home/test';
    const wsRoot = `${homedir}/Projects/ws-pending`;
    const vaultDir = `${wsRoot}/vault`;
    const fs = new MemoryFilesystem();

    await fs.mkdir(`${wsRoot}/.chamba`);
    await fs.writeFile(`${wsRoot}/.chamba/workspace.md`, '# WS\n');
    await fs.writeFile(
      `${wsRoot}/.chamba/parche.json`,
      JSON.stringify({ version: 1, server: PARCHE_SERVER, slug: 'team-alpha', vaultDir: 'vault' }),
    );
    await fs.mkdir(`${vaultDir}/.obsidian`);
    await fs.writeFile(`${vaultDir}/.obsidian/app.json`, '{}');
    await writeState(fs, vaultDir, {
      server: PARCHE_SERVER,
      slug: 'team-alpha',
      cursor: 0,
      files: {},
      lastSyncAt: FAKE_NOW,
      pendingAdoption: true,
    });
    const creds = new CredentialsStore(fs, homedir);
    await creds.set(PARCHE_SERVER, 'team-alpha', {
      token: 'pch_fake',
      user: { id: 'u1', name: 'Test' },
      device: { id: 'd1', label: 'dev' },
      role: 'editor',
      dir: vaultDir,
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
      cwd: wsRoot,
      homedir,
      http: parche,
      hash: new FakeHash(),
      parchePullTtlMin: 5,
      vaultMutex: new Map(),
    };

    const requestsBefore = parche.requestLog.length;
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_remember',
      arguments: { key: 'test', content: 'hello' },
    });

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(await fs.exists(`${vaultDir}/memory`)).toBe(true);
    expect(parche.requestLog.length).toBe(requestsBefore);
    expect(textOf(result)).toContain('npx @chamba/mcp vault');

    await server.close();
  });

  it('realpath-mismatch + dir exists → remember writes normally with warning, 0 sync', async () => {
    const parche = new FakeParche(makeClock());
    const homedir = '/home/test';
    const wsRoot = `${homedir}/Projects/ws-mismatch`;
    const vaultDir = `${wsRoot}/vault`;
    const altDir = `${wsRoot}/alt-vault`;
    const fs = new MemoryFilesystem();

    await fs.mkdir(`${wsRoot}/.chamba`);
    await fs.writeFile(`${wsRoot}/.chamba/workspace.md`, '# WS\n');
    await fs.writeFile(
      `${wsRoot}/.chamba/parche.json`,
      JSON.stringify({ version: 1, server: PARCHE_SERVER, slug: 'team-alpha', vaultDir: 'vault' }),
    );
    await fs.mkdir(`${vaultDir}/.obsidian`);
    await fs.writeFile(`${vaultDir}/.obsidian/app.json`, '{}');
    await writeState(fs, vaultDir, {
      server: PARCHE_SERVER,
      slug: 'team-alpha',
      cursor: 0,
      files: {},
      lastSyncAt: FAKE_NOW,
    });

    await fs.mkdir(`${altDir}/.obsidian`);
    await fs.writeFile(`${altDir}/.obsidian/app.json`, '{}');
    const creds = new CredentialsStore(fs, homedir);
    // Credential points to altDir (mismatch with binding's vaultDir)
    await creds.set(PARCHE_SERVER, 'team-alpha', {
      token: 'pch_fake',
      user: { id: 'u1', name: 'Test' },
      device: { id: 'd1', label: 'dev' },
      role: 'editor',
      dir: altDir,
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
      cwd: wsRoot,
      homedir,
      http: parche,
      hash: new FakeHash(),
      parchePullTtlMin: 5,
      vaultMutex: new Map(),
    };

    const requestsBefore = parche.requestLog.length;
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_remember',
      arguments: { key: 'test', content: 'hello' },
    });

    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(parche.requestLog.length).toBe(requestsBefore);
    expect(textOf(result)).toContain('npx @chamba/mcp vault');

    await server.close();
  });

  it('dir-missing → summarize_to_vault returns isError, env vault untouched', async () => {
    const parche = new FakeParche(makeClock());
    const homedir = '/home/test';
    const wsRoot = `${homedir}/Projects/ws-dir-missing`;
    const fs = new MemoryFilesystem();

    await fs.mkdir(`${wsRoot}/.chamba`);
    await fs.writeFile(`${wsRoot}/.chamba/workspace.md`, '# WS\n');
    await fs.writeFile(
      `${wsRoot}/.chamba/parche.json`,
      JSON.stringify({ version: 1, server: PARCHE_SERVER, slug: 'team-alpha', vaultDir: 'vault' }),
    );
    const creds = new CredentialsStore(fs, homedir);
    await creds.set(PARCHE_SERVER, 'team-alpha', {
      token: 'pch_fake',
      user: { id: 'u1', name: 'Test' },
      device: { id: 'd1', label: 'dev' },
      role: 'editor',
    });

    const envVault = `${homedir}/env-vault`;
    await fs.mkdir(`${envVault}/.obsidian`);
    await fs.writeFile(`${envVault}/.obsidian/app.json`, '{}');

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
      cwd: wsRoot,
      homedir,
      http: parche,
      hash: new FakeHash(),
      parchePullTtlMin: 5,
      vaultMutex: new Map(),
      obsidianVaultPath: envVault,
    };

    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_summarize_to_vault',
      arguments: { title: 'Test', content: 'Body.' },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(await fs.exists(`${envVault}/proyectos`)).toBe(false);

    await server.close();
  });
});

// ─── pullTtlMin: within TTL skips pull; past TTL triggers pull ─────────────

describe('pullTtlMin — binding autoSync.pullTtlMin controls pull cadence', () => {
  const RECENT_SYNC = '2026-06-09T09:58:00.000Z'; // 2 min before FAKE_NOW (within 5-min TTL)

  it('within TTL → load_context produces 0 pull requests', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'device' });
    const { svc } = await makeWorkspaceSvc({
      parche,
      homedir: '/home/test',
      slug: 'team-alpha',
      token,
      lastSyncAt: RECENT_SYNC,
    });

    const requestsBefore = parche.requestLog.length;
    const { client, server } = await connect(svc);

    await client.callTool({ name: 'chamba_load_context', arguments: { task: 'any task' } });

    const pulls = parche.requestLog
      .slice(requestsBefore)
      .filter((r) => r.method === 'GET' && r.url.includes('pull'));
    expect(pulls).toHaveLength(0);

    await server.close();
  });

  it('past TTL → load_context produces pull request', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'device' });
    const { svc } = await makeWorkspaceSvc({
      parche,
      homedir: '/home/test',
      slug: 'team-alpha',
      token,
      lastSyncAt: OLD_SYNC,
    });

    const requestsBefore = parche.requestLog.length;
    const { client, server } = await connect(svc);

    await client.callTool({ name: 'chamba_load_context', arguments: { task: 'any task' } });

    expect(parche.requestLog.length).toBeGreaterThan(requestsBefore);

    await server.close();
  });
});

// ─── Bug 4 / O2: invalid workspace parche.json → never fall through to env vault ──

describe('O2 — invalid workspace binding: no fallthrough', () => {
  async function makeInvalidBindingSvc(): Promise<{
    svc: Services;
    parche: FakeParche;
    envVaultDir: string;
  }> {
    const homedir = '/home/test';
    const wsRoot = `${homedir}/Projects/workspace`;
    const envVaultDir = `${homedir}/env-vault`;

    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-env', name: 'Team Env' });
    const token = parche.addDevice(group.id, { userId: 'u-env', label: 'env-device' });

    const fs = new MemoryFilesystem();

    // Workspace marker
    await fs.mkdir(`${wsRoot}/.chamba`);
    await fs.writeFile(`${wsRoot}/.chamba/workspace.md`, '# Workspace\n');
    // INVALID parche.json (not parseable JSON)
    await fs.writeFile(`${wsRoot}/.chamba/parche.json`, '{ this is not valid json !!!');

    // Env vault: valid state + credential
    await fs.mkdir(`${envVaultDir}/.obsidian`);
    await fs.writeFile(`${envVaultDir}/.obsidian/app.json`, '{}');
    await writeState(fs, envVaultDir, {
      server: PARCHE_SERVER,
      slug: 'team-env',
      cursor: 0,
      files: {},
      lastSyncAt: OLD_SYNC,
    });
    const creds = new CredentialsStore(fs, homedir);
    await creds.set(PARCHE_SERVER, 'team-env', {
      token,
      user: { id: 'u-env', name: 'env-user' },
      device: { id: 'd-env', label: 'env-device' },
      role: 'editor',
      dir: envVaultDir,
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
      cwd: wsRoot,
      homedir,
      http: parche,
      hash: new FakeHash(),
      parchePullTtlMin: 5,
      vaultMutex: new Map(),
      obsidianVaultPath: envVaultDir,
    };

    return { svc, parche, envVaultDir };
  }

  it('remember → isError (env vault untouched, 0 HTTP requests)', async () => {
    const { svc, parche, envVaultDir } = await makeInvalidBindingSvc();
    const requestsBefore = parche.requestLog.length;

    const { client, server } = await connect(svc);
    const result = await client.callTool({
      name: 'chamba_remember',
      arguments: { key: 'test-key', content: 'test content' },
    });

    const typed = result as { isError?: boolean; content: Array<{ text: string }> };
    expect(typed.isError).toBe(true);
    // 0 HTTP requests — env vault must not have been touched
    expect(parche.requestLog.length).toBe(requestsBefore);
    // Env vault notes must be untouched
    const envExists = await svc.fs.exists(`${envVaultDir}/.chamba/memory/test-key.md`);
    expect(envExists).toBe(false);

    await server.close();
  });

  it('recall → responds with invalid-binding warning, no env vault notes pulled', async () => {
    const { svc, parche } = await makeInvalidBindingSvc();
    const requestsBefore = parche.requestLog.length;

    const { client, server } = await connect(svc);
    const result = await client.callTool({
      name: 'chamba_recall',
      arguments: { query: 'test' },
    });

    const text = textOf(result);
    // Must mention parche.json (the invalid binding file)
    expect(text).toContain('parche.json');
    // 0 HTTP requests — env vault must not be pulled from
    expect(parche.requestLog.length).toBe(requestsBefore);

    await server.close();
  });
});

// ─── N2: recall reads from binding vault when bound-unsyncable + dirExists ──

describe('N2 — recall reads from binding vault when bound-unsyncable + dirExists', () => {
  it('recall returns binding vault memory + warning, NOT env vault memory', async () => {
    const parche = new FakeParche(makeClock());
    const homedir = '/home/test';
    const wsRoot = `${homedir}/Projects/my-ws`;
    const fs = new MemoryFilesystem();

    // Workspace marker + binding (no credential → bound-unsyncable)
    await fs.mkdir(`${wsRoot}/.chamba`);
    await fs.writeFile(`${wsRoot}/.chamba/workspace.md`, '# WS\n');
    const vaultDir = `${wsRoot}/vault`;
    await fs.writeFile(
      `${wsRoot}/.chamba/parche.json`,
      JSON.stringify({
        version: 1,
        server: PARCHE_SERVER,
        slug: 'team-alpha',
        vaultDir: 'vault',
        autoSync: { enabled: true, pullTtlMin: 5 },
      }),
    );
    // Create vault dir with a memory file ("binding memory")
    await fs.mkdir(`${vaultDir}/memory`);
    await fs.writeFile(
      `${vaultDir}/memory/binding-note.md`,
      '---\nkey: binding-note\ntags: []\n---\nbinding memory content',
    );

    // Create env vault dir with a different memory ("env memory")
    const envVaultDir = `${homedir}/env-vault`;
    await fs.mkdir(`${envVaultDir}/memory`);
    await fs.writeFile(
      `${envVaultDir}/memory/env-note.md`,
      '---\nkey: env-note\ntags: []\n---\nenv memory content',
    );

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
      cwd: wsRoot,
      homedir,
      http: parche,
      hash: new FakeHash(),
      parchePullTtlMin: 5,
      vaultMutex: new Map(),
      obsidianVaultPath: envVaultDir,
    };

    const { client, server } = await connect(svc);
    const result = await client.callTool({
      name: 'chamba_recall',
      arguments: { query: 'memory' },
    });

    const text = textOf(result);
    // Should find binding memory
    expect(text).toContain('binding memory content');
    // Should NOT find env memory
    expect(text).not.toContain('env memory content');
    // Should include warning
    expect(text).toContain('parche no sincronizable');

    await server.close();
  });
});

// ─── N3: summarize-to-vault with invalid binding → isError text has no "()" ──

describe('N3 — summarize_to_vault with invalid binding → isError text matches hint', () => {
  it('isError text contains hint without "()" pattern', async () => {
    const parche = new FakeParche(makeClock());
    const homedir = '/home/test';
    const wsRoot = `${homedir}/Projects/my-ws`;
    const fs = new MemoryFilesystem();

    // Workspace marker + INVALID parche.json (missing required fields)
    await fs.mkdir(`${wsRoot}/.chamba`);
    await fs.writeFile(`${wsRoot}/.chamba/workspace.md`, '# WS\n');
    await fs.writeFile(
      `${wsRoot}/.chamba/parche.json`,
      JSON.stringify({ version: 99, bad: 'data' }), // invalid schema
    );

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
      cwd: wsRoot,
      homedir,
      http: parche,
      hash: new FakeHash(),
      parchePullTtlMin: 5,
      vaultMutex: new Map(),
    };

    const { client, server } = await connect(svc);
    const result = await client.callTool({
      name: 'chamba_summarize_to_vault',
      arguments: { title: 'Test Note', content: 'test content' },
    });

    const typed = result as { isError?: boolean; content: Array<{ text: string }> };
    expect(typed.isError).toBe(true);
    const text = textOf(result);
    // Must NOT start with "()" — no empty parens
    expect(text).not.toMatch(/\(\)/);
    // Should contain the word "parche.json" or "inválido"
    expect(text).toMatch(/parche\.json|inválido|invalid/i);

    await server.close();
  });
});
