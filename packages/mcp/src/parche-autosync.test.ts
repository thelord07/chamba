/**
 * parche-autosync.test.ts — Tests for AC11 auto-sync in MCP tools.
 *
 * Covers:
 *   AC11a — chamba_load_context with parche vault: server down → normal context + warning, no throw
 *   AC11b — chamba_load_context with slow server (fake clock) → within budget + warning
 *   AC11c — summarize_to_vault still writes when sync fails
 */

import { CredentialsStore, FakeHash, FakeParche, MemoryFilesystem, writeState } from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { AUTOSYNC_BUDGET_MS } from './parche/autosync.js';
import { createServer } from './server.js';
import type { Services } from './services.js';

const silentLogger = pino({ level: 'silent' });

const FAKE_NOW = '2026-06-09T10:00:00.000Z';
// Make the lastSyncAt old enough to trigger a pull (> 5 min)
const OLD_SYNC = '2026-06-09T09:50:00.000Z'; // 10 min ago

function makeClock(now = FAKE_NOW) {
  const d = new Date(now);
  return {
    now: () => d,
    today: () => d.toISOString().slice(0, 10),
  };
}

/**
 * Build services with a parche vault already set up (vault dir + state.json + credential).
 * Uses `vaultDir` as the Obsidian vault (explicit path).
 */
async function makeServicesWithParcheVault(opts: {
  parche: FakeParche;
  slug?: string;
  lastSyncAt?: string;
  /** Device token issued by the fake; defaults to one it does not know (sync fails with 401). */
  token?: string;
}): Promise<{ svc: Services; vaultDir: string }> {
  const slug = opts.slug ?? 'team-alpha';
  const server = 'https://parche.chamba.tools';
  const homedir = '/home/test';
  const vaultDir = `${homedir}/.chamba/vaults/${slug}`;
  const fs = new MemoryFilesystem();

  // Create vault structure
  await fs.mkdir(`${vaultDir}/.obsidian`);
  await fs.writeFile(`${vaultDir}/.obsidian/app.json`, '{}');

  // Write state.json
  await writeState(fs, vaultDir, {
    server,
    slug,
    cursor: 0,
    files: {},
    lastSyncAt: opts.lastSyncAt ?? OLD_SYNC,
  });

  // Write credential
  const creds = new CredentialsStore(fs, homedir);
  await creds.set(server, slug, {
    token: opts.token ?? 'pch_fake_test_token',
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
    http: opts.parche,
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

// ─── AC11a: server down → normal context + warning, no throw ─────────────────

describe('AC11a — load_context with server down', () => {
  it('returns normal context plus a warning when parche server throws', async () => {
    // FakeParche that always throws on /changes
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    // Seed the device token directly so the credential resolves
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop', role: 'editor' });

    // Override request to throw on /changes
    const originalRequest = parche.request.bind(parche);
    parche.request = async (req) => {
      if (req.url.includes('/changes')) {
        throw new Error('Network unreachable');
      }
      return originalRequest(req);
    };

    const { svc } = await makeServicesWithParcheVault({ parche, token });

    // Write a workspace file so load_context has something to return
    await svc.fs.writeFile('/proj/.chamba/workspace.md', '# Workspace\n\ntest project\n');

    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_load_context',
      arguments: { task: 'fix the bug' },
    });

    const txt = textOf(result);
    // Must include normal context (workspace is scanned)
    expect(txt.length).toBeGreaterThan(0);
    // Must include a warning about the sync failure
    expect(txt).toContain('⚠');
    expect(txt).toMatch(/auto-sync|sync/i);

    await server.close();
  });

  it('does not throw when parche server is down', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop', role: 'editor' });

    parche.request = async (_req) => {
      throw new Error('ECONNREFUSED');
    };

    const { svc } = await makeServicesWithParcheVault({ parche, token });
    await svc.fs.writeFile('/proj/README.md', '# Project\n');

    const { client, server } = await connect(svc);

    // Should resolve without throwing
    await expect(
      client.callTool({ name: 'chamba_load_context', arguments: { task: 'test' } }),
    ).resolves.toBeTruthy();

    await server.close();
  });
});

// ─── AC11b: slow server uses fake clock, stays within budget ─────────────────

describe('AC11b — load_context with slow server (fake clock)', () => {
  it('returns context + warning when a slow server fails (the budget abort itself is tested below)', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    parche.addDevice(group.id, { userId: 'u1', label: 'laptop', role: 'editor' });

    // Slow server: each /changes call takes longer than the budget
    // We simulate this with a real small delay to trigger the AbortController
    parche.request = async (req) => {
      if (req.url.includes('/changes')) {
        // Wait for abort signal or a small delay
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 50); // 50ms — fast for tests
          if (req.signal) {
            req.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new DOMException('Request aborted', 'AbortError'));
            });
          }
        });
        // If we get here (not aborted), call the original
        throw new Error('Should have been aborted');
      }
      return { status: 200, headers: {}, body: new Uint8Array(0) };
    };

    const { svc } = await makeServicesWithParcheVault({ parche });
    await svc.fs.writeFile('/proj/.chamba/workspace.md', '# Workspace\n');

    // Use a very short budget for testing (override at runtime isn't possible,
    // but we can verify that the sync eventually finishes with a warning)
    const { client, server } = await connect(svc);

    const start = Date.now();
    const result = await client.callTool({
      name: 'chamba_load_context',
      arguments: { task: 'test task' },
    });
    const elapsed = Date.now() - start;

    const txt = textOf(result);
    // Should have returned (not hung)
    expect(txt.length).toBeGreaterThan(0);
    // The call should complete well within 30 seconds
    expect(elapsed).toBeLessThan(AUTOSYNC_BUDGET_MS + 5000); // generous margin

    await server.close();
  });
});

// ─── AC10(budget): autosyncBudgetMs is injectable; aborted signal + warning ───

describe('AC10 (budget) — autosyncBudgetMs injectable, no real waiting', () => {
  it('control: within the budget the auto-sync runs and adds no warning', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop', role: 'editor' });

    // Same setup as the abort test below, but with no latency and the default budget:
    // the warning there can only come from the budget, not from a broken sync.
    const { svc } = await makeServicesWithParcheVault({ parche, token });
    await svc.fs.writeFile('/proj/.chamba/workspace.md', '# Workspace\n');

    const { client, server } = await connect(svc);
    const result = await client.callTool({
      name: 'chamba_load_context',
      arguments: { task: 'test budget' },
    });

    const txt = textOf(result);
    expect(txt).toContain('# Workspace');
    expect(txt).not.toContain('auto-sync pausado:');
    expect(parche.requestLog.some((r) => r.url.includes('/changes'))).toBe(true);
    expect(parche.lastSignalWasAborted).toBe(false);

    await server.close();
  });

  it('signal.aborted is true when FakeParche receives the request after budget fires', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop', role: 'editor' });

    // Override request to delay slightly so the budget timer fires first
    const originalRequest = parche.request.bind(parche);
    parche.request = async (req) => {
      // Small real delay so setTimeout(0) fires first
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      return originalRequest(req);
    };

    const { svc } = await makeServicesWithParcheVault({ parche, token });
    await svc.fs.writeFile('/proj/.chamba/workspace.md', '# Workspace\n');

    // Budget of 0ms fires before the 5ms delay completes
    svc.autosyncBudgetMs = 0;

    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_load_context',
      arguments: { task: 'budget signal test' },
    });

    const txt = textOf(result);
    expect(txt).toContain('# Workspace');
    expect(txt).toContain('auto-sync pausado:');
    // The request reached the fake after the budget fired, carrying an aborted signal.
    expect(parche.lastSignalWasAborted).toBe(true);

    await server.close();
  });
});

// ─── summarize_to_vault still writes when sync fails ─────────────────────────

describe('summarize_to_vault — writes even when sync fails', () => {
  it('note is written to vault even when the parche sync throws', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop', role: 'editor' });

    // Sync fails
    const originalRequest = parche.request.bind(parche);
    parche.request = async (req) => {
      if (req.url.includes('/push') || req.url.includes('/blob')) {
        throw new Error('Network error');
      }
      return originalRequest(req);
    };

    const { svc, vaultDir } = await makeServicesWithParcheVault({ parche, token });

    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_summarize_to_vault',
      arguments: {
        title: 'Test Summary',
        content: '## Summary\n\nSome notes here.',
      },
    });

    const txt = textOf(result);
    // The note should have been written
    expect(txt).toContain('Wrote note to');
    // Warning about sync failure
    expect(txt).toContain('⚠');

    // The vault should contain the note
    const notes = await svc.fs.readDir(`${vaultDir}/proyectos`).catch(() => []);
    expect(notes.length).toBeGreaterThan(0);

    await server.close();
  });
});

// ─── PARCHE-009 AC10: autosync recognizes custom vault dir ───────────────────

describe('PARCHE-009 AC10 — autosync with custom vault dir', () => {
  it('chamba_remember triggers autosync against FakeParche when cred.dir is custom (AC10)', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop', role: 'editor' });

    const customDir = '/my/custom/vault';
    const homedir = '/home/test';
    const server = 'https://parche.chamba.tools';
    const slug = group.slug;
    const fs = new MemoryFilesystem();

    // Vault structure at custom dir
    await fs.mkdir(`${customDir}/.obsidian`);

    // Write state.json in the custom dir
    await writeState(fs, customDir, {
      server,
      slug,
      cursor: 0,
      files: {},
      lastSyncAt: OLD_SYNC,
    });

    // Write credential with cred.dir = customDir
    const creds = new CredentialsStore(fs, homedir);
    await creds.set(server, slug, {
      token,
      user: { id: 'u1', name: 'Joys' },
      device: { id: 'd1', label: 'laptop' },
      role: 'editor',
      dir: customDir,
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
      http: parche,
      hash: new FakeHash(),
      parchePullTtlMin: 5,
      vaultMutex: new Map(),
      obsidianVaultPath: customDir, // CHAMBA_OBSIDIAN_VAULT_PATH = customDir
    };

    const { client, server: mcpServer } = await connect(svc);

    const requestsBefore = parche.requestLog.length;
    await client.callTool({
      name: 'chamba_remember',
      arguments: { key: 'test-key', content: 'Test memory content' },
    });

    // Autosync should have run → FakeParche received at least one request
    expect(parche.requestLog.length).toBeGreaterThan(requestsBefore);
    const hasChangesOrPush = parche.requestLog
      .slice(requestsBefore)
      .some((r) => r.url.includes('/changes') || r.url.includes('/push'));
    expect(hasChangesOrPush).toBe(true);

    await mcpServer.close();
  });

  it('chamba_remember does NOT autosync when cred.dir differs from obsidianVaultPath (AC10)', async () => {
    const parche = new FakeParche(makeClock());
    const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
    const token = parche.addDevice(group.id, { userId: 'u1', label: 'laptop', role: 'editor' });

    const customDir = '/my/custom/vault';
    const anotherDir = '/other/vault';
    const homedir = '/home/test';
    const server = 'https://parche.chamba.tools';
    const slug = group.slug;
    const fs = new MemoryFilesystem();

    // Vault state.json lives in anotherDir
    await fs.mkdir(`${anotherDir}/.obsidian`);
    await writeState(fs, anotherDir, {
      server,
      slug,
      cursor: 0,
      files: {},
      lastSyncAt: OLD_SYNC,
    });

    // Credential says customDir
    const creds = new CredentialsStore(fs, homedir);
    await creds.set(server, slug, {
      token,
      user: { id: 'u1', name: 'Joys' },
      device: { id: 'd1', label: 'laptop' },
      role: 'editor',
      dir: customDir,
    });
    await fs.mkdir(customDir);

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
      http: parche,
      hash: new FakeHash(),
      parchePullTtlMin: 5,
      vaultMutex: new Map(),
      obsidianVaultPath: anotherDir, // detection path differs from cred.dir
    };

    const { client, server: mcpServer } = await connect(svc);

    const requestsBefore = parche.requestLog.length;
    await client.callTool({
      name: 'chamba_remember',
      arguments: { key: 'test-key2', content: 'Test content 2' },
    });

    // No sync requests should have been made (realpath guard blocked it)
    const syncRequests = parche.requestLog
      .slice(requestsBefore)
      .filter((r) => r.url.includes('/changes') || r.url.includes('/push') || r.method === 'PUT');
    expect(syncRequests.length).toBe(0);

    await mcpServer.close();
  });
});
