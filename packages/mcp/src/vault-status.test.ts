import { MemoryFilesystem } from '@chamba/core';
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
});
