import { MemoryFilesystem } from '@chamba/core';
import { describe, expect, it } from 'vitest';
import { Installer } from './installer.js';

const ASSETS = {
  '/assets/commands/orq.md': '# orq',
  '/assets/commands/workspace.md': '# workspace',
  '/assets/commands/worktrees.md': '# worktrees',
  '/assets/commands/recall.md': '# recall',
  '/assets/agents/implementer.md': '# implementer',
  '/assets/agents/reviewer.md': '# reviewer',
  '/assets/agents/tester.md': '# tester',
  '/assets/hooks/PreToolUse-warn-destructive.sh': '#!/usr/bin/env bash',
  '/assets/hooks/PostToolUse-validate-worktree.sh': '#!/usr/bin/env bash',
};

function build(extra: Record<string, string> = {}) {
  const fs = new MemoryFilesystem({ ...ASSETS, ...extra });
  const installer = new Installer({
    fs,
    assetsDir: '/assets',
    claudeDir: '/home/.claude',
    claudeJsonPath: '/home/.claude.json',
  });
  return { fs, installer };
}

describe('Installer.install', () => {
  it('installs all assets and registers the MCP server', async () => {
    const { fs, installer } = build({ '/home/.claude.json': '{}' });
    const result = await installer.install();

    expect(result.counts).toEqual({ commands: 4, agents: 3, hooks: 2 });
    expect(result.mcpAdded).toBe(true);
    expect(await fs.exists('/home/.claude/commands/orq.md')).toBe(true);
    expect(await fs.exists('/home/.claude/agents/implementer.md')).toBe(true);
    expect(await fs.exists('/home/.claude/hooks/PreToolUse-warn-destructive.sh')).toBe(true);

    const config = JSON.parse(await fs.readFile('/home/.claude.json'));
    expect(config.mcpServers.chamba).toEqual({ command: 'npx', args: ['-y', '@chamba/mcp'] });
  });

  it('is idempotent: a second run skips existing files and notes mcp present', async () => {
    const { installer } = build({ '/home/.claude.json': '{}' });
    await installer.install();
    const second = await installer.install();

    expect(second.installed).toEqual([]);
    expect(second.skipped).toHaveLength(9);
    expect(second.mcpAlreadyPresent).toBe(true);
  });

  it('--force overwrites existing files', async () => {
    const { fs, installer } = build();
    await installer.install();
    await fs.writeFile('/home/.claude/commands/orq.md', 'edited by user');

    const result = await installer.install({ force: true });
    expect(result.skipped).toEqual([]);
    expect(await fs.readFile('/home/.claude/commands/orq.md')).toBe('# orq');
  });

  it('preserves other MCP servers in .claude.json', async () => {
    const { fs, installer } = build({
      '/home/.claude.json': JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
    });
    await installer.install();

    const config = JSON.parse(await fs.readFile('/home/.claude.json'));
    expect(config.mcpServers.other).toEqual({ command: 'x' });
    expect(config.mcpServers.chamba).toBeDefined();
  });
});

describe('Installer.uninstall', () => {
  it('removes installed files and the MCP server, keeping others', async () => {
    const { fs, installer } = build({
      '/home/.claude.json': JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
    });
    await installer.install();

    const result = await installer.uninstall();
    expect(result.removed).toHaveLength(9);
    expect(result.mcpRemoved).toBe(true);
    expect(await fs.exists('/home/.claude/commands/orq.md')).toBe(false);

    const config = JSON.parse(await fs.readFile('/home/.claude.json'));
    expect(config.mcpServers.chamba).toBeUndefined();
    expect(config.mcpServers.other).toEqual({ command: 'x' });
  });
});
