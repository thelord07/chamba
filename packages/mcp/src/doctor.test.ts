import { MemoryFilesystem } from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import type { Services } from './services.js';

const silentLogger = pino({ level: 'silent' });

type ExecHandler = (command: string, args: string[]) => { stdout?: string; exitCode?: number };

function makeServices(
  files: Record<string, string>,
  opts: { vaultPath?: string; exec?: ExecHandler } = {},
): Services {
  const exec: ExecHandler = opts.exec ?? (() => ({}));
  return {
    fs: new MemoryFilesystem(files),
    process: {
      exec: async (command, args) => {
        const out = exec(command, args);
        return { stdout: out.stdout ?? '', stderr: '', exitCode: out.exitCode ?? 0 };
      },
    },
    clock: { now: () => new Date('2026-07-05T10:00:00Z'), today: () => '2026-07-05' },
    cwd: '/proj',
    homedir: '/home/test',
    obsidianVaultPath: opts.vaultPath,
  };
}

async function connect(svc: Services) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer(silentLogger, svc);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

interface Structured {
  healthy: boolean;
  ok: number;
  warn: number;
  fail: number;
  checks: { id: string; status: string; detail: string }[];
}

function structured(result: unknown): Structured {
  return (result as { structuredContent: Structured }).structuredContent;
}

const gitRepo: ExecHandler = (cmd, args) => {
  if (cmd === 'git' && args[0] === '--version') return { stdout: 'git version 2.43.0' };
  if (cmd === 'git' && args[0] === 'rev-parse') return { stdout: 'true\n' };
  if (cmd === 'git' && args[0] === 'worktree') return { stdout: 'worktree /proj\n' };
  return {};
};

describe('chamba_doctor', () => {
  it('returns a structured report with a checks array', async () => {
    const { client, server } = await connect(
      makeServices(
        {
          '/vault/.obsidian/app.json': '{}',
          '/vault/n.md': '# n\n',
          '/proj/.chamba/workspace.md': '# Workspace\n',
        },
        { vaultPath: '/vault', exec: gitRepo },
      ),
    );

    const out = structured(await client.callTool({ name: 'chamba_doctor', arguments: {} }));
    const ids = out.checks.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining(['node', 'git', 'git-repo', 'workspace', 'config', 'vault', 'logs']),
    );

    const find = (id: string) => out.checks.find((c) => c.id === id);
    expect(find('git-repo')?.status).toBe('ok');
    expect(find('workspace')?.status).toBe('ok');
    expect(find('vault')?.status).toBe('ok');
    expect(find('config')?.status).toBe('ok');

    await server.close();
  });

  it('warns when the cwd is not a git repo and no vault is set', async () => {
    // default exec returns exitCode 0 + empty stdout → rev-parse != "true"
    const { client, server } = await connect(makeServices({}));
    const out = structured(await client.callTool({ name: 'chamba_doctor', arguments: {} }));

    const find = (id: string) => out.checks.find((c) => c.id === id);
    expect(find('git-repo')?.status).toBe('warn');
    expect(find('workspace')?.status).toBe('warn');
    expect(find('vault')?.status).toBe('warn');
    // worktrees check is skipped outside a git repo
    expect(find('worktrees')).toBeUndefined();

    await server.close();
  });
});
