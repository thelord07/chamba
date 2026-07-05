import { MemoryFilesystem } from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import type { Services } from './services.js';

const silentLogger = pino({ level: 'silent' });

function services(files: Record<string, string>, vaultPath?: string): Services {
  return {
    fs: new MemoryFilesystem(files),
    process: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    clock: { now: () => new Date('2026-06-09T00:00:00Z'), today: () => '2026-06-09' },
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

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.map((c) => c.text).join('\n');
}

const projectFiles = {
  '/proj/package.json': JSON.stringify({ name: 'proj', dependencies: { express: '^4' } }),
  '/proj/src/index.ts': 'export {};\n',
};

const vaultFiles = {
  '/vault/.obsidian/app.json': '{}',
  '/vault/auth.md': '# Auth\n\nWe use magic links for authentication.\n',
};

describe('obsidian tools', () => {
  it('load_context returns workspace summary and relevant vault notes', async () => {
    const { client, server } = await connect(
      services({ ...projectFiles, ...vaultFiles }, '/vault'),
    );

    const result = await client.callTool({
      name: 'chamba_load_context',
      arguments: { task: 'add authentication with magic links' },
    });
    const text = textOf(result);

    expect(text).toContain('## Workspace context');
    expect(text).toContain('auth.md');

    await server.close();
  });

  it('summarize_to_vault writes a note when a vault is configured', async () => {
    const svc = services({ ...projectFiles, ...vaultFiles }, '/vault');
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_summarize_to_vault',
      arguments: { title: 'Auth decisions', content: 'We use magic links.' },
    });
    expect(textOf(result)).toContain('Wrote note to /vault/proyectos/2026-06-09-auth-decisions.md');
    expect(await svc.fs.exists('/vault/proyectos/2026-06-09-auth-decisions.md')).toBe(true);

    await server.close();
  });

  it('save_plan writes the plan under the vault plans/ folder', async () => {
    const svc = services({ ...projectFiles, ...vaultFiles }, '/vault');
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_save_plan',
      arguments: { title: 'TICKET-123', content: '## Goal\nDo X.' },
    });
    expect(textOf(result)).toContain('Saved plan to /vault/plans/2026-06-09-ticket-123.md');
    const note = await svc.fs.readFile('/vault/plans/2026-06-09-ticket-123.md');
    expect(note).toContain('tags: [chamba, plan]');
    expect(note).toContain('Do X.');

    await server.close();
  });

  it('summarize_to_vault errors clearly when no vault is configured', async () => {
    const { client, server } = await connect(services(projectFiles));

    const result = await client.callTool({
      name: 'chamba_summarize_to_vault',
      arguments: { title: 'x', content: 'y' },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toContain('No Obsidian vault configured');

    await server.close();
  });
});
