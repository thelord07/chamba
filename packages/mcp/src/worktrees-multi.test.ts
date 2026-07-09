import { MemoryFilesystem } from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import type { Services } from './services.js';

const silentLogger = pino({ level: 'silent' });

type GitReply = (args: string[]) => { stdout?: string; stderr?: string; exitCode?: number };

function makeServices(files: Record<string, string>, git: GitReply): Services {
  return {
    fs: new MemoryFilesystem(files),
    process: {
      exec: async (_cmd, args) => {
        const r = git(args);
        return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.exitCode ?? 0 };
      },
    },
    clock: { now: () => new Date('2026-06-09T10:00:00Z'), today: () => '2026-06-09' },
    system: {
      resources: () => ({
        totalMemBytes: 16 * 1024 ** 3,
        freeMemBytes: 8 * 1024 ** 3,
        cpus: 8,
        loadAvg1: 0,
      }),
    },
    cwd: '/ws',
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

// branches don't exist anywhere → everything is created fresh
const allNew: GitReply = (args) => {
  if (args[0] === 'show-ref') return { exitCode: 1 };
  if (args[0] === 'ls-remote') return { exitCode: 2 };
  return { exitCode: 0 };
};

describe('chamba_create_worktrees', () => {
  it('autodetects repos and creates a worktree per repo (sibling default)', async () => {
    const svc = makeServices(
      {
        '/ws/api/.git/HEAD': 'ref: refs/heads/main\n',
        '/ws/web/.git/HEAD': 'ref: refs/heads/main\n',
        '/ws/.chamba/config.json': JSON.stringify({
          version: 1,
          worktrees: { branchPrefix: 'ticket/' },
        }),
      },
      allNew,
    );
    const { client, server } = await connect(svc);

    const out = structured(
      await client.callTool({ name: 'chamba_create_worktrees', arguments: { ticket: 'TICKET-1' } }),
    );
    expect(out.branch).toBe('ticket/TICKET-1');
    const wts = out.worktrees as Array<{ repo: string; status: string; worktreePath: string }>;
    expect(wts.map((w) => w.repo).sort()).toEqual(['api', 'web']);
    expect(wts.every((w) => w.status === 'created')).toBe(true);
    expect(wts.find((w) => w.repo === 'api')?.worktreePath).toBe('/ws/WORKTREES/TICKET-1/api');

    await server.close();
  });

  it('writes a .code-workspace when configured', async () => {
    const svc = makeServices(
      {
        '/ws/api/.git/HEAD': 'ref: refs/heads/main\n',
        '/ws/.chamba/config.json': JSON.stringify({
          version: 1,
          worktrees: { editorWorkspace: 'code-workspace', repos: ['api'] },
        }),
      },
      allNew,
    );
    const { client, server } = await connect(svc);

    const out = structured(
      await client.callTool({ name: 'chamba_create_worktrees', arguments: { ticket: 'T-2' } }),
    );
    expect(out.workspaceFile).toBe('/ws/WORKTREES/T-2/T-2.code-workspace');
    expect(await svc.fs.exists('/ws/WORKTREES/T-2/T-2.code-workspace')).toBe(true);

    await server.close();
  });

  it('uses the command escape hatch when set', async () => {
    let ranCmd = '';
    const svc = makeServices(
      {
        '/ws/.chamba/config.json': JSON.stringify({
          version: 1,
          worktrees: { command: './make-wt.sh {ticket}' },
        }),
      },
      (args) => {
        if (args[0] === '-c') ranCmd = args[1] ?? '';
        return { stdout: 'done', exitCode: 0 };
      },
    );
    const { client, server } = await connect(svc);

    const out = structured(
      await client.callTool({ name: 'chamba_create_worktrees', arguments: { ticket: 'T-3' } }),
    );
    expect(out.usedCommand).toBe(true);
    expect(ranCmd).toBe('./make-wt.sh T-3');

    await server.close();
  });
});

describe('chamba_cleanup_worktrees', () => {
  it('removes worktrees and reports merge suggestions, keeping branches', async () => {
    const svc = makeServices(
      {
        '/ws/api/.git/HEAD': 'ref: refs/heads/main\n',
        '/ws/WORKTREES/T-9/api/.git': 'gitdir: ...',
        '/ws/.chamba/config.json': JSON.stringify({
          version: 1,
          worktrees: { repos: ['api'], branchPrefix: 'ticket/' },
        }),
      },
      allNew,
    );
    const { client, server } = await connect(svc);

    const out = structured(
      await client.callTool({ name: 'chamba_cleanup_worktrees', arguments: { ticket: 'T-9' } }),
    );
    const wts = out.worktrees as Array<{ repo: string; removed: boolean; mergeSuggestion: string }>;
    expect(wts[0]?.removed).toBe(true);
    expect(wts[0]?.mergeSuggestion).toContain('merge --no-ff ticket/T-9');

    await server.close();
  });
});
