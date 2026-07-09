import { FakeProcess, MemoryFilesystem, type ProcessHandler } from '@chamba/core';
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

worktree /repo/.chamba/worktrees/test/w1
HEAD bbb
branch refs/heads/chamba/2026-06-09-test/w1
`;

function services(handler: ProcessHandler): { svc: Services; process: FakeProcess } {
  const process = new FakeProcess(handler);
  return {
    process,
    svc: {
      fs: new MemoryFilesystem({}),
      process,
      clock: { now: () => new Date('2026-06-09T00:00:00Z'), today: () => '2026-06-09' },
      system: {
        resources: () => ({
          totalMemBytes: 16 * 1024 ** 3,
          freeMemBytes: 8 * 1024 ** 3,
          cpus: 8,
          loadAvg1: 0,
        }),
      },
      cwd: '/repo',
      homedir: '/home/test',
    },
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

const gitRepoHandler: ProcessHandler = (_cmd, args) => {
  if (args[0] === 'rev-parse') return { stdout: 'true', exitCode: 0 };
  if (args[0] === 'worktree' && args[1] === 'list') return { stdout: PORCELAIN, exitCode: 0 };
  return { exitCode: 0 };
};

describe('worktree tools', () => {
  it('create_worktree errors clearly when not a git repo', async () => {
    const { svc } = services(() => ({ exitCode: 128, stderr: 'not a git repository' }));
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_create_worktree',
      arguments: { taskSlug: 'test', workerId: 'w1' },
    });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(textOf(result)).toBe('Not a git repo, worktree skipped. Worker should use main cwd.');

    await server.close();
  });

  it('create_worktree creates a branch in a git repo', async () => {
    const { svc, process } = services(gitRepoHandler);
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_create_worktree',
      arguments: { taskSlug: 'test', workerId: 'w1' },
    });
    expect(textOf(result)).toContain('chamba/2026-06-09-test/w1');
    expect(process.calls.some((c) => c.args[0] === 'worktree' && c.args[1] === 'add')).toBe(true);

    await server.close();
  });

  it('cleanup_worktree removes the dir but keeps the branch, no --force', async () => {
    const { svc, process } = services(gitRepoHandler);
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_cleanup_worktree',
      arguments: { branch: 'chamba/2026-06-09-test/w1' },
    });
    expect(textOf(result)).toContain('Branch kept');
    expect(textOf(result)).toContain('git merge --no-ff chamba/2026-06-09-test/w1');

    const dangerous = process.calls.filter(
      (c) => c.args.includes('--force') || c.args[0] === 'merge' || c.args.includes('-D'),
    );
    expect(dangerous).toEqual([]);

    await server.close();
  });
});
