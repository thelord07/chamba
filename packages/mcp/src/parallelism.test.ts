import { FakeNet, FakeProcess, MemoryFilesystem, type ProcessHandler } from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import type { Services } from './services.js';

const silentLogger = pino({ level: 'silent' });

const PORCELAIN = `worktree /repo
HEAD aaa
branch refs/heads/main

worktree /repo/.chamba/worktrees/auth/w1
HEAD bbb
branch refs/heads/chamba/auth
`;

function makeServices(handler: ProcessHandler, files: Record<string, string> = {}): Services {
  return {
    fs: new MemoryFilesystem(files),
    process: new FakeProcess(handler),
    clock: { now: () => new Date('2026-08-26T12:00:00Z'), today: () => '2026-08-26' },
    system: {
      resources: () => ({
        totalMemBytes: 16 * 1024 ** 3,
        freeMemBytes: 8 * 1024 ** 3,
        cpus: 8,
        loadAvg1: 0,
      }),
    },
    net: new FakeNet(),
    cwd: '/repo',
    homedir: '/home/test',
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

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.map((c) => c.text).join('\n');
}

const inspectHandler: ProcessHandler = (_cmd, args, opts) => {
  if (args[0] === 'worktree' && args[1] === 'list') return { stdout: PORCELAIN };
  if (args[0] === 'status') {
    return { stdout: opts?.cwd?.includes('auth/w1') ? ' M src/auth/login.ts\n' : '' };
  }
  if (args[0] === 'rev-list' && args.includes('--left-right')) return { stdout: '0\t1' };
  if (args[0] === 'log') return { stdout: '2026-08-26T10:00:00Z\n' };
  if (args[0] === 'diff' && args.includes('main...HEAD')) {
    return { stdout: opts?.cwd?.includes('auth/w1') ? 'src/auth/login.ts\n' : '' };
  }
  if (args[0] === 'rev-parse') return { exitCode: 1 };
  if (args[0] === 'merge-tree' && args[1] === '--name-only') {
    return { stdout: 'src/auth/login.ts\n', exitCode: 1 };
  }
  return { exitCode: 0 };
};

describe('chamba_worktree_status', () => {
  it('reports dirty linked worktrees without merging', async () => {
    const process = new FakeProcess(inspectHandler);
    const svc = makeServices(inspectHandler);
    svc.process = process;
    const { client, server } = await connect(svc);
    const out = structured(
      await client.callTool({ name: 'chamba_worktree_status', arguments: {} }),
    );
    expect(out.ok).toBe(true);
    expect(
      textOf(await client.callTool({ name: 'chamba_worktree_status', arguments: {} })),
    ).toContain('dirty');
    expect(process.calls.some((c) => c.args[0] === 'merge')).toBe(false);
    await server.close();
  });
});

describe('chamba_conflict_preview', () => {
  it('lists merge-tree conflicts and never runs git merge', async () => {
    const process = new FakeProcess(inspectHandler);
    const svc = makeServices(inspectHandler);
    svc.process = process;
    const { client, server } = await connect(svc);
    const out = structured(
      await client.callTool({ name: 'chamba_conflict_preview', arguments: {} }),
    );
    expect(out.conflictedCount).toBeGreaterThan(0);
    expect(process.calls.some((c) => c.args[0] === 'merge')).toBe(false);
    expect(process.calls.some((c) => c.args.includes('--force'))).toBe(false);
    await server.close();
  });
});

describe('chamba_partition', () => {
  it('splits explicit overlapping items into waves', async () => {
    const { client, server } = await connect(makeServices(() => ({ exitCode: 0 })));
    const out = structured(
      await client.callTool({
        name: 'chamba_partition',
        arguments: {
          items: [
            { id: 'a', paths: ['src/auth.ts'] },
            { id: 'b', paths: ['src/auth.ts'] },
          ],
        },
      }),
    );
    expect(out.kind).toBe('explicit');
    expect((out.waves as unknown[]).length).toBe(2);
    expect((out.overlaps as unknown[]).length).toBe(1);
    await server.close();
  });

  it('treats plan paths as predicted (warning only)', async () => {
    const { client, server } = await connect(makeServices(() => ({ exitCode: 0 })));
    const out = structured(
      await client.callTool({
        name: 'chamba_partition',
        arguments: {
          plan: `## Subtasks\n\n1. **implementer** — A\n   - files likely touched: src/a.ts\n2. **implementer** — B\n   - files likely touched: src/a.ts\n`,
        },
      }),
    );
    expect(out.kind).toBe('predicted');
    expect(out.ok).toBe(true);
    await server.close();
  });
});

describe('chamba_worktree_env', () => {
  it('is a no-op when ports are disabled', async () => {
    const { client, server } = await connect(makeServices(() => ({ exitCode: 0 })));
    const out = structured(
      await client.callTool({ name: 'chamba_worktree_env', arguments: { worktreePath: '/wt/a' } }),
    );
    expect(out.enabled).toBe(false);
    await server.close();
  });

  it('writes PORT to .env.local when enabled', async () => {
    const svc = makeServices(() => ({ exitCode: 0 }), {
      '/repo/.chamba/config.json': JSON.stringify({
        version: 1,
        worktrees: { ports: { enabled: true } },
      }),
    });
    const { client, server } = await connect(svc);
    const out = structured(
      await client.callTool({ name: 'chamba_worktree_env', arguments: { worktreePath: '/wt/a' } }),
    );
    expect(out.enabled).toBe(true);
    expect(await svc.fs.readFile('/wt/a/.env.local')).toContain('PORT=3000');
    await server.close();
  });
});
