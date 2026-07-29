import { MemoryFilesystem } from '@chamba/core';
import { describe, expect, it } from 'vitest';
import { OpencodeInstaller } from './installer.js';

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
  const installer = new OpencodeInstaller({
    fs,
    assetsDir: '/assets',
    opencodeDir: '/oc',
    globalConfigPath: '/home/.chamba/config.json',
  });
  return { fs, installer };
}

describe('OpencodeInstaller.install', () => {
  it('writes commands + agents in OpenCode format and registers the MCP server', async () => {
    const { fs, installer } = build();
    const result = await installer.install();

    expect(result.counts).toEqual({ commands: 2, agents: 2 });
    expect(result.mcpAdded).toBe(true);

    const orq = await fs.readFile('/oc/commands/orq.md');
    expect(orq).toContain('description: Orchestrate a task');
    expect(orq).not.toContain('argument-hint');
    expect(orq).toContain('Do $ARGUMENTS.');

    const planner = await fs.readFile('/oc/agents/planner.md');
    expect(planner).toContain('mode: subagent');
    expect(planner).toContain('model: anthropic/claude-opus-5'); // default reparto
    expect(planner).not.toContain('effort');

    const cfg = JSON.parse(await fs.readFile('/oc/opencode.json'));
    expect(cfg.mcp.chamba).toEqual({
      type: 'local',
      command: ['npx', '-y', '@chamba/mcp'],
      enabled: true,
    });
    expect(cfg.$schema).toContain('opencode.ai');
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
    await fs.writeFile('/oc/commands/orq.md', 'edited by user');
    const result = await installer.install({ force: true });
    expect(result.skipped).toEqual([]);
    expect(await fs.readFile('/oc/commands/orq.md')).toContain('description: Orchestrate a task');
  });

  it('--global registers the chamba-mcp binary and upgrades an npx entry', async () => {
    const { fs, installer } = build();
    await installer.install(); // npx entry
    const second = await installer.install({ global: true });
    expect(second.mcpAdded).toBe(true);
    const cfg = JSON.parse(await fs.readFile('/oc/opencode.json'));
    expect(cfg.mcp.chamba).toEqual({ type: 'local', command: ['chamba-mcp'], enabled: true });
  });

  it('preserves other MCP servers already in opencode.json', async () => {
    const { fs, installer } = build({
      '/oc/opencode.json': JSON.stringify({ mcp: { other: { type: 'local', command: ['x'] } } }),
    });
    await installer.install();
    const cfg = JSON.parse(await fs.readFile('/oc/opencode.json'));
    expect(cfg.mcp.other).toEqual({ type: 'local', command: ['x'] });
    expect(cfg.mcp.chamba).toBeDefined();
  });

  it('omits the model for a non-Anthropic role config', async () => {
    const { fs, installer } = build({
      '/home/.chamba/config.json': JSON.stringify({
        version: 1,
        overrides: { planner: { model: 'gpt-5.5' } },
      }),
    });
    await installer.install();
    const planner = await fs.readFile('/oc/agents/planner.md');
    expect(planner).not.toContain('model: anthropic');
    expect(planner).toContain('not Anthropic');
  });
});

describe('OpencodeInstaller.uninstall', () => {
  it('removes installed files and the MCP entry, keeping other servers', async () => {
    const { fs, installer } = build({
      '/oc/opencode.json': JSON.stringify({ mcp: { other: { type: 'local', command: ['x'] } } }),
    });
    await installer.install();

    const result = await installer.uninstall();
    expect(result.removed).toHaveLength(4);
    expect(result.mcpRemoved).toBe(true);
    expect(await fs.exists('/oc/commands/orq.md')).toBe(false);

    const cfg = JSON.parse(await fs.readFile('/oc/opencode.json'));
    expect(cfg.mcp.chamba).toBeUndefined();
    expect(cfg.mcp.other).toBeDefined();
  });
});
