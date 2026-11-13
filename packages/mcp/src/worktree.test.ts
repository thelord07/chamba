import {
  type ClockPort,
  type DirEntry,
  FakeHash,
  FakeParche,
  FakeProcess,
  FakeRandom,
  type FileStat,
  type FilesystemPort,
  MemoryFilesystem,
  type ProcessHandler,
  type WriteBytesOptions,
} from '@chamba/core';
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

/**
 * Delegating FS wrapper that counts operations under `.chamba/metrics/`.
 *
 * A plain object spread (`{ ...memoryFilesystemInstance }`) only copies OWN
 * enumerable properties — methods like `mkdir`/`readFile` live on the class
 * PROTOTYPE, so a spread silently drops them (`instrumented.mkdir` becomes
 * `undefined`). `atomicWrite` would then throw on its `mkdir` call, the span
 * write would fail inside `recordToolSpan`'s try/catch, and a test asserting
 * "at most 1 call" would pass vacuously because zero calls ever happened.
 * This wrapper implements every `FilesystemPort` method explicitly, so every
 * delegate call is real and the counts are meaningful.
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

/**
 * Clock that advances `stepMs` on every `now()` call (B9 del plan). Usado solo
 * para `services.clock` (el reloj de `recordToolSpan`'s t0/t1) — el reloj de
 * `http`/`FakeParche` se mantiene constante por separado, como pide la review.
 */
function advancingClock(startIso: string, stepMs = 1_000): ClockPort {
  let t = Date.parse(startIso);
  return {
    now: () => {
      const d = new Date(t);
      t += stepMs;
      return d;
    },
    today: () => new Date(t).toISOString().slice(0, 10),
  };
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

describe('chamba_create_worktree — CHAMBA-024 span attribution (T2)', () => {
  function inflightFile(workItem: string) {
    return `/repo/.chamba/metrics/inflight/${workItem}.json`;
  }

  it('(a) con inflight y workItem explícito → phases.setup.toolMs > 0, ms sin tocar', async () => {
    const { svc } = services(gitRepoHandler);
    svc.fs = new MemoryFilesystem({
      [inflightFile('CHAMBA-024')]: JSON.stringify({
        workItem: 'CHAMBA-024',
        startedAt: '2026-06-09T00:00:00Z',
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
    });
    // advancingClock (no vacuous >= 0): cada llamada a now() avanza 1000ms, así
    // t1 - t0 del span de git es siempre > 0 y múltiplo de stepMs.
    const STEP_MS = 1_000;
    svc.clock = advancingClock('2026-06-09T00:00:00Z', STEP_MS);
    const { client, server } = await connect(svc);

    await client.callTool({
      name: 'chamba_create_worktree',
      arguments: { taskSlug: 'test', workerId: 'w1', workItem: 'CHAMBA-024' },
    });

    const raw = await svc.fs.readFile(inflightFile('CHAMBA-024'));
    const inflight = JSON.parse(raw);
    expect(inflight.phases.setup.toolMs).toBeGreaterThan(0);
    expect(inflight.phases.setup.toolMs % STEP_MS).toBe(0);
    expect(inflight.phases.setup.toolCount).toBe(1);
    expect(inflight.phases.setup.ms).toBe(0); // S5: nunca en el share

    await server.close();
  });

  it('(b) sin workItem pero con taskSlug que normaliza al mismo id → se atribuye', async () => {
    const { svc } = services(gitRepoHandler);
    svc.fs = new MemoryFilesystem({
      [inflightFile('CHAMBA-024')]: JSON.stringify({
        workItem: 'CHAMBA-024',
        startedAt: '2026-06-09T00:00:00Z',
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
    });
    const { client, server } = await connect(svc);

    await client.callTool({
      name: 'chamba_create_worktree',
      arguments: { taskSlug: 'chamba-024', workerId: 'w1' },
    });

    const raw = await svc.fs.readFile(inflightFile('CHAMBA-024'));
    const inflight = JSON.parse(raw);
    expect(inflight.phases.setup.toolCount).toBe(1);

    await server.close();
  });

  it('(c) dos tareas activas y ningún match → nada se escribe (sin fallback)', async () => {
    const { svc } = services(gitRepoHandler);
    svc.fs = new MemoryFilesystem({
      [inflightFile('CHAMBA-024')]: JSON.stringify({
        workItem: 'CHAMBA-024',
        startedAt: '2026-06-09T00:00:00Z',
      }),
      [inflightFile('CHAMBA-025')]: JSON.stringify({
        workItem: 'CHAMBA-025',
        startedAt: '2026-06-09T00:00:00Z',
      }),
    });
    const { client, server } = await connect(svc);

    await client.callTool({
      name: 'chamba_create_worktree',
      arguments: { taskSlug: 'no-match', workerId: 'w1' },
    });

    expect(await svc.fs.exists(inflightFile('CHAMBA-024'))).toBe(true);
    const raw = await svc.fs.readFile(inflightFile('CHAMBA-024'));
    expect(JSON.parse(raw).phases).toBeUndefined();

    await server.close();
  });

  it('(d) sin ninguna tarea activa → texto idéntico, cero archivos bajo .chamba/metrics/', async () => {
    const { svc } = services(gitRepoHandler);
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_create_worktree',
      arguments: { taskSlug: 'test', workerId: 'w1' },
    });
    expect(textOf(result)).toContain('chamba/2026-06-09-test/w1');
    expect(await svc.fs.exists('/repo/.chamba/metrics')).toBe(false);

    await server.close();
  });

  it('(f) contador de operaciones FS bajo .chamba/metrics/ es exacto, y el span SÍ se escribe', async () => {
    const { svc } = services(gitRepoHandler);
    const baseFs = new MemoryFilesystem({
      [inflightFile('CHAMBA-024')]: JSON.stringify({
        workItem: 'CHAMBA-024',
        startedAt: '2026-06-09T00:00:00Z',
        phases: {},
      }),
    });
    const counting = new CountingFilesystem(baseFs);
    svc.fs = counting;
    const { client, server } = await connect(svc);

    await client.callTool({
      name: 'chamba_create_worktree',
      arguments: { taskSlug: 'chamba-024', workerId: 'w1' },
    });

    expect(counting.calls.filter((c) => c === 'readDir')).toHaveLength(1);
    expect(counting.calls.filter((c) => c === 'readFile')).toHaveLength(1);
    expect(counting.calls.filter((c) => c === 'writeBytes')).toHaveLength(1);

    // La prueba no es vacua: el span efectivamente se escribió.
    const raw = await baseFs.readFile(inflightFile('CHAMBA-024'));
    const inflight = JSON.parse(raw);
    expect(inflight.phases.setup.toolCount).toBe(1);

    await server.close();
  });

  it('T2e: writeBytes falla → el tool sigue devolviendo éxito, salida idéntica', async () => {
    const { svc } = services(gitRepoHandler);
    const baseFs = new MemoryFilesystem({
      [inflightFile('CHAMBA-024')]: JSON.stringify({
        workItem: 'CHAMBA-024',
        startedAt: '2026-06-09T00:00:00Z',
        phases: {},
      }),
    });
    class ThrowingWriteFs extends CountingFilesystem {
      override writeBytes(
        path: string,
        data: Uint8Array,
        opts?: Parameters<FilesystemPort['writeBytes']>[2],
      ) {
        if (path.includes('.chamba/metrics')) {
          return Promise.reject(new Error('disk full (simulated)'));
        }
        return super.writeBytes(path, data, opts);
      }
    }
    svc.fs = new ThrowingWriteFs(baseFs);

    // Baseline: same taskSlug/workerId (so the branch name matches exactly),
    // but no inflight file at all → recordToolSpan finds no match and never
    // calls writeBytes. Comparing against this isolates the throw's effect.
    const { svc: baselineSvc } = services(gitRepoHandler);
    const { client: clientOk, server: serverOk } = await connect(baselineSvc);
    const okResult = await clientOk.callTool({
      name: 'chamba_create_worktree',
      arguments: { taskSlug: 'chamba-024', workerId: 'w1' },
    });
    await serverOk.close();

    const { client, server } = await connect(svc);
    const result = await client.callTool({
      name: 'chamba_create_worktree',
      arguments: { taskSlug: 'chamba-024', workerId: 'w1' },
    });

    expect((result as { isError?: boolean }).isError).toBeUndefined();
    expect(textOf(result)).toBe(textOf(okResult));
    expect(result).toEqual(okResult);

    await server.close();
  });

  it('T2g: create_worktree(workItem) + chamba_task_metrics(phase event) en Promise.all — sin deadlock, ambas escrituras presentes', async () => {
    const { svc } = services(gitRepoHandler);
    svc.fs = new MemoryFilesystem({
      [inflightFile('CHAMBA-024')]: JSON.stringify({
        workItem: 'CHAMBA-024',
        startedAt: '2026-06-09T00:00:00Z',
        routeSuggested: 'small',
        routeFinal: 'small',
        escalations: 0,
        planReviewRounds: 0,
        verifyRounds: 0,
        sessionId: 's1',
        navReadBodyBaseline: 0,
        source: 'ticket',
        phases: {},
        humanWaits: { count: 0, ms: 0, byReason: {} },
      }),
    });
    const { client, server } = await connect(svc);

    // withVaultLock no es reentrante (B7): esto solo es seguro porque
    // recordToolSpan y chamba_task_metrics toman el mismo mutex, cada uno
    // una sola vez, nunca anidado. Si alguno lo tomara dos veces, esto
    // colgaría — el timeout de vitest lo haría fallar en vez de bloquear
    // la suite para siempre.
    const [worktreeResult, metricsResult] = await Promise.all([
      client.callTool({
        name: 'chamba_create_worktree',
        arguments: { taskSlug: 'test', workerId: 'w1', workItem: 'CHAMBA-024' },
      }),
      client.callTool({
        name: 'chamba_task_metrics',
        arguments: { action: 'event', workItem: 'CHAMBA-024', kind: 'phase_start', phase: 'plan' },
      }),
    ]);

    expect((worktreeResult as { isError?: boolean }).isError).toBeUndefined();
    expect((metricsResult as { isError?: boolean }).isError).toBeUndefined();

    const raw = await svc.fs.readFile(inflightFile('CHAMBA-024'));
    const inflight = JSON.parse(raw);
    // Ambas escrituras deben estar presentes — ninguna pisó a la otra bajo el lock.
    expect(inflight.phases.setup).toBeDefined();
    expect(inflight.phases.setup.toolCount).toBe(1);
    expect(inflight.activePhase?.phase === 'plan' || inflight.phases.plan !== undefined).toBe(true);

    await server.close();
  }, 10_000);
});
