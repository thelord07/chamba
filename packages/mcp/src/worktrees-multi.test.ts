import {
  type DirEntry,
  FakeHash,
  FakeParche,
  FakeRandom,
  type FileStat,
  type FilesystemPort,
  MemoryFilesystem,
  type WriteBytesOptions,
} from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import type { Services } from './services.js';

/**
 * Same delegating wrapper as worktree.test.ts (B2 de la review ronda 1): un
 * spread `{...memoryFilesystemInstance}` pierde los métodos del prototipo
 * (`mkdir` queda `undefined`), haciendo que la escritura del span falle en
 * silencio y el contador de operaciones sea vacuo. Esta clase delega cada
 * método explícitamente.
 */
class CountingFilesystem implements FilesystemPort {
  readonly calls: string[] = [];
  constructor(private readonly inner: FilesystemPort) {}
  private count(op: string, path: string): void {
    if (path.includes('.chamba/metrics')) this.calls.push(op);
  }
  readFile(path: string): Promise<string> {
    this.count('readFile', path);
    return this.inner.readFile(path);
  }
  writeFile(path: string, content: string): Promise<void> {
    this.count('writeFile', path);
    return this.inner.writeFile(path, content);
  }
  readDir(path: string): Promise<DirEntry[]> {
    this.count('readDir', path);
    return this.inner.readDir(path);
  }
  exists(path: string): Promise<boolean> {
    this.count('exists', path);
    return this.inner.exists(path);
  }
  mkdir(path: string): Promise<void> {
    this.count('mkdir', path);
    return this.inner.mkdir(path);
  }
  remove(path: string): Promise<void> {
    this.count('remove', path);
    return this.inner.remove(path);
  }
  readBytes(path: string): Promise<Uint8Array> {
    this.count('readBytes', path);
    return this.inner.readBytes(path);
  }
  writeBytes(path: string, data: Uint8Array, opts?: WriteBytesOptions): Promise<void> {
    this.count('writeBytes', path);
    return this.inner.writeBytes(path, data, opts);
  }
  rename(from: string, to: string): Promise<void> {
    this.count('rename', from);
    return this.inner.rename(from, to);
  }
  stat(path: string): Promise<FileStat | null> {
    this.count('stat', path);
    return this.inner.stat(path);
  }
  realpath(path: string): Promise<string> {
    this.count('realpath', path);
    return this.inner.realpath(path);
  }
}

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
    http: new FakeParche({
      now: () => new Date('2026-06-09T00:00:00Z'),
      today: () => '2026-06-09',
    }),
    hash: new FakeHash(),
    random: new FakeRandom(),
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
    platform: 'linux',
    username: 'testuser',
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

describe('chamba_create_worktrees — CHAMBA-024 span attribution', () => {
  it('attributes git span to phases.setup.toolMs when workItem matches an inflight', async () => {
    const svc = makeServices(
      {
        '/ws/api/.git/HEAD': 'ref: refs/heads/main\n',
        '/ws/.chamba/config.json': JSON.stringify({
          version: 1,
          worktrees: { branchPrefix: 'ticket/', repos: ['api'] },
        }),
        '/ws/.chamba/metrics/inflight/TICKET-9.json': JSON.stringify({
          workItem: 'TICKET-9',
          startedAt: '2026-06-09T09:00:00Z',
          routeSuggested: 'small',
          routeFinal: 'small',
          escalations: 0,
          planReviewRounds: 0,
          verifyRounds: 0,
          sessionId: 's1',
          navReadBodyBaseline: 0,
          source: 'ticket',
          phases: {},
        }),
      },
      allNew,
    );
    const { client, server } = await connect(svc);

    await client.callTool({
      name: 'chamba_create_worktrees',
      arguments: { ticket: 'TICKET-9', workItem: 'TICKET-9' },
    });

    const raw = await svc.fs.readFile('/ws/.chamba/metrics/inflight/TICKET-9.json');
    const inflight = JSON.parse(raw);
    expect(inflight.phases.setup.toolCount).toBe(1);
    expect(inflight.phases.setup.ms).toBe(0);

    await server.close();
  });

  it('B3: el contador de operaciones FS es independiente del número de repos (>=2 repos)', async () => {
    const svc = makeServices(
      {
        '/ws/api/.git/HEAD': 'ref: refs/heads/main\n',
        '/ws/web/.git/HEAD': 'ref: refs/heads/main\n',
        '/ws/worker/.git/HEAD': 'ref: refs/heads/main\n',
        '/ws/.chamba/config.json': JSON.stringify({
          version: 1,
          worktrees: { branchPrefix: 'ticket/', repos: ['api', 'web', 'worker'] },
        }),
        '/ws/.chamba/metrics/inflight/TICKET-9.json': JSON.stringify({
          workItem: 'TICKET-9',
          startedAt: '2026-06-09T09:00:00Z',
          routeSuggested: 'small',
          routeFinal: 'small',
          escalations: 0,
          planReviewRounds: 0,
          verifyRounds: 0,
          sessionId: 's1',
          navReadBodyBaseline: 0,
          source: 'ticket',
          phases: {},
        }),
      },
      allNew,
    );
    const baseFs = svc.fs;
    const counting = new CountingFilesystem(baseFs);
    svc.fs = counting;
    const { client, server } = await connect(svc);

    await client.callTool({
      name: 'chamba_create_worktrees',
      arguments: { ticket: 'TICKET-9', workItem: 'TICKET-9' },
    });

    // 3 repos, pero el span se mide/escribe UNA sola vez, fuera del bucle de repos.
    expect(counting.calls.filter((c) => c === 'readDir')).toHaveLength(1);
    expect(counting.calls.filter((c) => c === 'readFile')).toHaveLength(1);
    expect(counting.calls.filter((c) => c === 'writeBytes')).toHaveLength(1);

    const raw = await baseFs.readFile('/ws/.chamba/metrics/inflight/TICKET-9.json');
    const inflight = JSON.parse(raw);
    expect(inflight.phases.setup.toolCount).toBe(1);

    await server.close();
  });
});
