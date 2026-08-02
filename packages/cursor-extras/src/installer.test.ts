import { MemoryFilesystem } from '@chamba/core';
import { describe, expect, it } from 'vitest';
import { CursorInstaller } from './installer.js';

const ASSETS = {
  '/assets/commands/orq.md':
    '---\ndescription: Orchestrate a task\nargument-hint: "<task>"\n---\nDo $ARGUMENTS.\n',
  '/assets/commands/ticket.md': '---\ndescription: Resolve a ticket\n---\nResolve $ARGUMENTS.\n',
  '/assets/agents/planner.md':
    '---\nname: planner\ndescription: Plans the work\n---\nYou are the planner.\n',
  '/assets/agents/diagnostician.md':
    '---\nname: diagnostician\ndescription: Diagnoses read-only\n---\nYou investigate.\n',
};

function build(extra: Record<string, string> = {}) {
  const fs = new MemoryFilesystem({ ...ASSETS, ...extra });
  const installer = new CursorInstaller({
    fs,
    assetsDir: '/assets',
    cursorDir: '/cur',
    globalConfigPath: '/home/.chamba/config.json',
  });
  return { fs, installer };
}

describe('CursorInstaller.install', () => {
  it('writes commands (body only) + agents (frontmatter) and registers the MCP server', async () => {
    const { fs, installer } = build();
    const result = await installer.install();

    expect(result.counts).toEqual({ commands: 2, agents: 2 });
    expect(result.mcpAdded).toBe(true);

    // Cursor commands are plain markdown, no frontmatter.
    const orq = await fs.readFile('/cur/commands/orq.md');
    expect(orq.trim()).toBe('Do $ARGUMENTS.');
    expect(orq).not.toContain('description:');

    const planner = await fs.readFile('/cur/agents/planner.md');
    expect(planner).toContain('name: planner');
    expect(planner).toContain('model: claude-opus-5'); // bare id from the default reparto
    expect(planner).toContain('You are the planner.');

    const cfg = JSON.parse(await fs.readFile('/cur/mcp.json'));
    expect(cfg.mcpServers.chamba).toEqual({ command: 'npx', args: ['-y', '@chamba/mcp'] });
  });

  it('is idempotent: a second run skips existing files and notes mcp present', async () => {
    const { installer } = build();
    await installer.install();
    const second = await installer.install();
    expect(second.installed).toEqual([]);
    expect(second.skipped).toHaveLength(4);
    expect(second.mcpAlreadyPresent).toBe(true);
  });

  it('--force overwrites existing files', async () => {
    const { fs, installer } = build();
    await installer.install();
    await fs.writeFile('/cur/commands/orq.md', 'edited by user');
    const result = await installer.install({ force: true });
    expect(result.skipped).toEqual([]);
    expect((await fs.readFile('/cur/commands/orq.md')).trim()).toBe('Do $ARGUMENTS.');
  });

  it('--global registers the chamba-mcp binary and upgrades an npx entry', async () => {
    const { fs, installer } = build();
    await installer.install(); // npx entry
    const second = await installer.install({ global: true });
    expect(second.mcpAdded).toBe(true);
    const cfg = JSON.parse(await fs.readFile('/cur/mcp.json'));
    expect(cfg.mcpServers.chamba).toEqual({ command: 'chamba-mcp' });
  });

  it('preserves other MCP servers already in mcp.json', async () => {
    const { fs, installer } = build({
      '/cur/mcp.json': JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
    });
    await installer.install();
    const cfg = JSON.parse(await fs.readFile('/cur/mcp.json'));
    expect(cfg.mcpServers.other).toEqual({ command: 'x' });
    expect(cfg.mcpServers.chamba).toBeDefined();
  });

  it('uses model: inherit for a non-Anthropic role config', async () => {
    const { fs, installer } = build({
      '/home/.chamba/config.json': JSON.stringify({
        version: 1,
        overrides: { planner: { model: 'gpt-5.5' } },
      }),
    });
    await installer.install();
    const planner = await fs.readFile('/cur/agents/planner.md');
    expect(planner).toContain('model: inherit');
  });
});

describe('CursorInstaller.uninstall', () => {
  it('removes installed files and the MCP entry, keeping other servers', async () => {
    const { fs, installer } = build({
      '/cur/mcp.json': JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
    });
    await installer.install();

    const result = await installer.uninstall();
    expect(result.removed).toHaveLength(4);
    expect(result.mcpRemoved).toBe(true);
    expect(await fs.exists('/cur/commands/orq.md')).toBe(false);

    const cfg = JSON.parse(await fs.readFile('/cur/mcp.json'));
    expect(cfg.mcpServers.chamba).toBeUndefined();
    expect(cfg.mcpServers.other).toBeDefined();
  });
});
