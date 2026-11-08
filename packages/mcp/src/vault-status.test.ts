import { FakeHash, FakeParche, FakeRandom, MemoryFilesystem } from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import type { Services } from './services.js';

const silentLogger = pino({ level: 'silent' });

function makeServices(files: Record<string, string>, vaultPath?: string): Services {
  return {
    fs: new MemoryFilesystem(files),
    process: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    clock: { now: () => new Date('2026-06-10T10:00:00Z'), today: () => '2026-06-10' },
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
    http: new FakeParche({
      now: () => new Date('2026-06-09T00:00:00Z'),
      today: () => '2026-06-09',
    }),
    hash: new FakeHash(),
    random: new FakeRandom(),
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
    platform: 'linux',
    username: 'testuser',
    obsidianVaultPath: vaultPath,
  };
}

async function connect(svc: Services) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer(silentLogger, svc);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

describe('chamba_vault_status', () => {
  it('lists the notes chamba can see at the vault root', async () => {
    const svc = makeServices(
      {
        '/vault/.obsidian/app.json': '{}',
        '/vault/domain-model.md': '# Domain\n',
        '/vault/repos-overview.md': '# Repos\n',
      },
      '/vault',
    );
    const { client, server } = await connect(svc);

    const out = structured(await client.callTool({ name: 'chamba_vault_status', arguments: {} }));
    expect(out.found).toBe(true);
    expect(out.vaultPath).toBe('/vault');
    expect(out.noteCount).toBe(2); // .obsidian skipped
    expect(out.notes).toEqual(expect.arrayContaining(['domain-model.md', 'repos-overview.md']));

    await server.close();
  });

  it('corrects a path pointing at .obsidian and still finds the real notes', async () => {
    const svc = makeServices(
      {
        '/vault/.obsidian/app.json': '{}',
        '/vault/notes/a.md': '# A\n',
      },
      '/vault/.obsidian',
    );
    const { client, server } = await connect(svc);

    const out = structured(await client.callTool({ name: 'chamba_vault_status', arguments: {} }));
    expect(out.vaultPath).toBe('/vault');
    expect(out.noteCount).toBe(1);

    await server.close();
  });

  it('reports when no vault is found', async () => {
    const { client, server } = await connect(makeServices({}));
    const out = structured(await client.callTool({ name: 'chamba_vault_status', arguments: {} }));
    expect(out.found).toBe(false);
    await server.close();
  });

  // CHAMBA-015 D2.5: skippedByName shown in structuredContent and text
  it('D2.5: skippedByName reflects skippedPaths count from state (via workspace binding)', async () => {
    const stateJson = JSON.stringify({
      server: 'https://parche.chamba.tools',
      slug: 'my-vault',
      cursor: 0,
      files: {},
      lastSyncAt: '2026-06-10T00:00:00.000Z',
      skippedPaths: {
        'CON.md': 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'LPT1.txt': 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    });
    const parcheJson = JSON.stringify({
      version: 1,
      server: 'https://parche.chamba.tools',
      slug: 'my-vault',
      vaultDir: '/vault',
    });
    // Use global scope (no workspace.md → global parche.json at homedir)
    const svc = makeServices(
      {
        '/vault/.obsidian/app.json': '{}',
        '/vault/note.md': '# Note\n',
        '/vault/.chamba-sync/state.json': stateJson,
        '/home/test/.chamba/parche.json': parcheJson,
      },
      '/vault',
    );

    const { client, server } = await connect(svc);
    const result = await client.callTool({ name: 'chamba_vault_status', arguments: {} });
    const out = structured(result);

    expect(out.skippedByName).toBe(2);
    // Also in text
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text ?? '';
    expect(text).toContain('Skipped (Windows-invalid names): 2');

    await server.close();
  });

  it('D2.5: skippedByName is 0 when no skippedPaths in state', async () => {
    const svc = makeServices(
      {
        '/vault/.obsidian/app.json': '{}',
        '/vault/note.md': '# Note\n',
      },
      '/vault',
    );
    const { client, server } = await connect(svc);
    const out = structured(await client.callTool({ name: 'chamba_vault_status', arguments: {} }));
    expect(out.skippedByName).toBe(0);
    await server.close();
  });
});
