import { MemoryFilesystem } from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createServer, SERVER_VERSION } from './server.js';
import type { Services } from './services.js';

// Silent logger: tests must not write to stdout (it's the MCP channel).
const silentLogger = pino({ level: 'silent' });

function buildServices(files: Record<string, string>, cwd: string): Services {
  return {
    fs: new MemoryFilesystem(files),
    process: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    clock: { now: () => new Date('2026-06-09T00:00:00Z'), today: () => '2026-06-09' },
    system: {
      resources: () => ({
        totalMemBytes: 16 * 1024 ** 3,
        freeMemBytes: 8 * 1024 ** 3,
        cpus: 8,
        loadAvg1: 0,
      }),
    },
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
      'chamba_cleanup_worktree',
      'chamba_cleanup_worktrees',
      'chamba_conflict_preview',
      'chamba_create_worktree',
      'chamba_create_worktrees',
      'chamba_design_prefs',
      'chamba_doctor',
      'chamba_generate_plan',
      'chamba_get_agent_config',
      'chamba_list_worktrees',
      'chamba_load_context',
      'chamba_load_design',
      'chamba_load_skills',
      'chamba_partition',
      'chamba_qa_capabilities',
      'chamba_recall',
      'chamba_remember',
      'chamba_resource_budget',
      'chamba_review_plan',
      'chamba_save_plan',
      'chamba_summarize_to_vault',
      'chamba_triage_ticket',
      'chamba_vault_status',
      'chamba_workspace_init',
      'chamba_workspace_reload',
      'chamba_workspace_show',
      'chamba_worktree_env',
      'chamba_worktree_status',
    ]);

    await server.close();
  });

  it('reports its real published version in the handshake (not 0.0.0)', async () => {
    // SERVER_VERSION is read from package.json, so the MCP handshake advertises
    // the actual published version instead of a hardcoded placeholder.
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(SERVER_VERSION).not.toBe('0.0.0');

    const { client, server } = await connect(buildServices({}, '/proj'));
    const info = client.getServerVersion();
    expect(info?.name).toBe('chamba');
    expect(info?.version).toBe(SERVER_VERSION);

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

  it('workspace_init bootstraps a GLOBAL vault outside the repo when none exists', async () => {
    const services = buildServices(
      { '/proj/package.json': JSON.stringify({ name: 'proj' }) },
      '/proj',
    );
    const { client, server } = await connect(services);

    const result = await client.callTool({ name: 'chamba_workspace_init', arguments: {} });
    expect(textOf(result)).toContain('created a global vault');
    // Seeded under the home dir, outside the project — never in /proj.
    expect(await services.fs.exists('/home/test/.chamba/vault/.obsidian/app.json')).toBe(true);
    expect(await services.fs.exists('/home/test/.chamba/vault/Workspace overview.md')).toBe(true);
    expect(await services.fs.exists('/proj/.obsidian/app.json')).toBe(false);

    await server.close();
  });

  it('workspace_init gitignores a legacy vault found inside a git repo', async () => {
    const services = buildServices(
      {
        '/proj/package.json': JSON.stringify({ name: 'proj' }),
        '/proj/.git/HEAD': 'ref: refs/heads/main\n',
        '/proj/.obsidian/app.json': '{}',
      },
      '/proj',
    );
    const { client, server } = await connect(services);

    const result = await client.callTool({ name: 'chamba_workspace_init', arguments: {} });
    expect(textOf(result)).toContain('gitignored its artifacts');
    expect(await services.fs.readFile('/proj/.gitignore')).toContain('.obsidian/');

    await server.close();
  });

  it('workspace_init leaves an existing vault untouched', async () => {
    const services: Services = {
      ...buildServices(
        {
          '/proj/package.json': JSON.stringify({ name: 'proj' }),
          '/vault/.obsidian/app.json': '{}',
        },
        '/proj',
      ),
      obsidianVaultPath: '/vault',
    };
    const { client, server } = await connect(services);

    const result = await client.callTool({ name: 'chamba_workspace_init', arguments: {} });
    expect(textOf(result)).toContain('using the existing one at /vault');
    expect(await services.fs.exists('/proj/.obsidian/app.json')).toBe(false);

    await server.close();
  });

  it('workspace_init skips vault creation with createVault: false', async () => {
    const services = buildServices(
      { '/proj/package.json': JSON.stringify({ name: 'proj' }) },
      '/proj',
    );
    const { client, server } = await connect(services);

    await client.callTool({
      name: 'chamba_workspace_init',
      arguments: { createVault: false },
    });
    expect(await services.fs.exists('/proj/.obsidian/app.json')).toBe(false);

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
