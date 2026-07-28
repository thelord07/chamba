import { MemoryFilesystem } from '@chamba/core';
import { describe, expect, it } from 'vitest';
import { Installer } from './installer.js';
import { SnapshotStore } from './snapshot-store.js';

const ASSETS = {
  '/assets/commands/orq.md': '# orq',
  '/assets/commands/ticket.md': '# ticket',
  '/assets/commands/triage.md': '# triage',
  '/assets/commands/workspace.md': '# workspace',
  '/assets/commands/worktrees.md': '# worktrees',
  '/assets/commands/recall.md': '# recall',
  '/assets/commands/vault.md': '# vault',
  '/assets/agents/planner.md': '# planner',
  '/assets/agents/implementer.md': '# implementer',
  '/assets/agents/reviewer.md': '# reviewer',
  '/assets/agents/tester.md': '# tester',
  '/assets/agents/qa.md': '# qa',
  '/assets/agents/diagnostician.md': '# diagnostician',
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
    globalConfigPath: '/home/.chamba/config.json',
  });
  return { fs, installer };
}

describe('Installer.install', () => {
  it('installs all assets and registers the MCP server', async () => {
    const { fs, installer } = build({ '/home/.claude.json': '{}' });
    const result = await installer.install();

    expect(result.counts).toEqual({ commands: 7, agents: 6, hooks: 2 });
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
    expect(second.skipped).toHaveLength(15);
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

describe('Installer.applyConfig', () => {
  it('regenerates the subagents from defaults and is idempotent', async () => {
    const { fs, installer } = build();
    const first = await installer.applyConfig();
    expect(first.regenerated.sort()).toEqual([
      'agents/diagnostician.md',
      'agents/implementer.md',
      'agents/planner.md',
      'agents/qa.md',
      'agents/reviewer.md',
      'agents/tester.md',
    ]);

    const impl = await fs.readFile('/home/.claude/agents/implementer.md');
    expect(impl).toContain('model: claude-sonnet-5');
    expect(impl).toContain('effort: medium');

    const planner = await fs.readFile('/home/.claude/agents/planner.md');
    expect(planner).toContain('model: claude-opus-5');
    expect(planner).toContain('effort: high');

    const second = await installer.applyConfig();
    expect(second.regenerated).toEqual([]);
    expect(second.unchanged).toHaveLength(6);
  });

  it('reflects a config override when regenerating', async () => {
    const { fs, installer } = build({
      '/home/.chamba/config.json': JSON.stringify({
        version: 1,
        overrides: { implementer: { model: 'claude-haiku-4-5', effort: 'low' } },
      }),
    });
    await installer.applyConfig();
    const impl = await fs.readFile('/home/.claude/agents/implementer.md');
    expect(impl).toContain('model: claude-haiku-4-5');
    expect(impl).toContain('effort: low');
  });

  it('omits model for a non-Anthropic model and notes inherit', async () => {
    const { fs, installer } = build({
      '/home/.chamba/config.json': JSON.stringify({
        version: 1,
        overrides: { reviewer: { model: 'gpt-5.5' } },
      }),
    });
    await installer.applyConfig();
    const reviewer = await fs.readFile('/home/.claude/agents/reviewer.md');
    expect(reviewer).not.toContain('model: gpt-5.5');
    expect(reviewer).toContain('not an Anthropic model');
  });
});

describe('Installer.uninstall', () => {
  it('removes installed files and the MCP server, keeping others', async () => {
    const { fs, installer } = build({
      '/home/.claude.json': JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
    });
    await installer.install();

    const result = await installer.uninstall();
    expect(result.removed).toHaveLength(15);
    expect(result.mcpRemoved).toBe(true);
    expect(await fs.exists('/home/.claude/commands/orq.md')).toBe(false);

    const config = JSON.parse(await fs.readFile('/home/.claude.json'));
    expect(config.mcpServers.chamba).toBeUndefined();
    expect(config.mcpServers.other).toEqual({ command: 'x' });
  });
});

function buildWithStore(extra: Record<string, string> = {}) {
  const fs = new MemoryFilesystem({ ...ASSETS, ...extra });
  let clock = '2026-07-12T10:00:00.000Z';
  const store = new SnapshotStore(fs, '/home/.chamba/backups', () => clock);
  const installer = new Installer({
    fs,
    assetsDir: '/assets',
    claudeDir: '/home/.claude',
    claudeJsonPath: '/home/.claude.json',
    globalConfigPath: '/home/.chamba/config.json',
    snapshotStore: store,
  });
  return {
    fs,
    installer,
    setClock: (t: string) => {
      clock = t;
    },
  };
}

describe('Installer snapshots & rollback', () => {
  it('snapshots before --force and rolls back the previous content', async () => {
    const { fs, installer } = buildWithStore({ '/home/.claude.json': '{}' });
    await installer.install(); // plain install: no snapshot
    await fs.writeFile('/home/.claude/commands/orq.md', 'MY EDIT');

    await installer.install({ force: true }); // snapshots the edit, then overwrites
    expect(await fs.readFile('/home/.claude/commands/orq.md')).toBe('# orq'); // clobbered

    const rb = await installer.rollback();
    expect(rb?.restored).toContain('/home/.claude/commands/orq.md');
    expect(rb?.reason).toBe('install --force');
    expect(await fs.readFile('/home/.claude/commands/orq.md')).toBe('MY EDIT'); // restored
  });

  it('snapshots before uninstall and can restore the removed files + MCP entry', async () => {
    const { fs, installer } = buildWithStore({ '/home/.claude.json': '{}' });
    await installer.install();

    await installer.uninstall();
    expect(await fs.exists('/home/.claude/commands/orq.md')).toBe(false);
    expect(JSON.parse(await fs.readFile('/home/.claude.json')).mcpServers?.chamba).toBeUndefined();

    const rb = await installer.rollback();
    expect(rb).not.toBeNull();
    expect(await fs.exists('/home/.claude/commands/orq.md')).toBe(true);
    expect(JSON.parse(await fs.readFile('/home/.claude.json')).mcpServers.chamba).toBeDefined();
  });

  it('does not snapshot on a plain (non-force) install', async () => {
    const { installer } = buildWithStore({ '/home/.claude.json': '{}' });
    await installer.install();
    expect(await installer.listSnapshots()).toHaveLength(0);
  });

  it('rollback is a no-op without a configured store', async () => {
    const { installer } = build({ '/home/.claude.json': '{}' });
    await installer.install();
    expect(await installer.rollback()).toBeNull();
  });
});
