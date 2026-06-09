import { MemoryFilesystem } from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import type { Services } from './services.js';

// Silent logger: tests must not write to stdout (it's the MCP channel).
const silentLogger = pino({ level: 'silent' });

function buildServices(files: Record<string, string>, cwd: string): Services {
  return {
    fs: new MemoryFilesystem(files),
    process: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    clock: { now: () => new Date('2026-06-09T00:00:00Z'), today: () => '2026-06-09' },
    cwd,
    homedir: '/home/test',
  };
}

async function connect(services: Services) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(silentLogger, services);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content.map((c) => c.text).join('\n');
}

describe('chamba MCP server', () => {
  it('exposes the workspace and obsidian tools', async () => {
    const { client, server } = await connect(buildServices({}, '/proj'));
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([
      'chamba_generate_plan',
      'chamba_load_context',
      'chamba_review_plan',
      'chamba_summarize_to_vault',
      'chamba_workspace_init',
      'chamba_workspace_reload',
      'chamba_workspace_show',
    ]);

    await server.close();
  });

  it('workspace_init scans and writes .chamba/workspace.md', async () => {
    const services = buildServices(
      {
        '/proj/package.json': JSON.stringify({ name: 'proj', dependencies: { express: '^4' } }),
        '/proj/src/index.ts': 'export {};\n',
      },
      '/proj',
    );
    const { client, server } = await connect(services);

    const result = await client.callTool({ name: 'chamba_workspace_init', arguments: {} });
    expect(textOf(result)).toContain('Created');

    expect(await services.fs.exists('/proj/.chamba/workspace.md')).toBe(true);
    const written = await services.fs.readFile('/proj/.chamba/workspace.md');
    expect(written).toContain('# Workspace');
    expect(written).toContain('Express');

    await server.close();
  });

  it('workspace_init does not overwrite an existing workspace.md', async () => {
    const services = buildServices(
      {
        '/proj/package.json': JSON.stringify({ name: 'proj' }),
        '/proj/.chamba/workspace.md': '# My hand-written workspace\n',
      },
      '/proj',
    );
    const { client, server } = await connect(services);

    const result = await client.callTool({ name: 'chamba_workspace_init', arguments: {} });
    expect(textOf(result)).toContain('already exists');
    expect(await services.fs.readFile('/proj/.chamba/workspace.md')).toBe(
      '# My hand-written workspace\n',
    );

    await server.close();
  });

  it('workspace_reload returns a diff without overwriting hand edits', async () => {
    const services = buildServices(
      {
        '/proj/package.json': JSON.stringify({ name: 'proj', dependencies: { express: '^4' } }),
        '/proj/.chamba/workspace.md': '# Workspace\n\nedited by hand\n',
      },
      '/proj',
    );
    const { client, server } = await connect(services);

    const result = await client.callTool({ name: 'chamba_workspace_reload', arguments: {} });
    const text = textOf(result);
    expect(text).toContain('NOT applied');
    expect(text).toContain('Express');

    // File is untouched.
    expect(await services.fs.readFile('/proj/.chamba/workspace.md')).toBe(
      '# Workspace\n\nedited by hand\n',
    );

    await server.close();
  });
});
