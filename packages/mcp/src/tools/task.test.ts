/**
 * tools/task.test.ts — CHAMBA-022 (C7)
 *
 * Tests 1–6 of the ticket's §4, at tool level, over the real MCP server
 * (in-memory transport, same harness as task-metrics.test.ts).
 */

import {
  FakeHash,
  FakeParche,
  FakeRandom,
  MemoryFilesystem,
  type ProcessPort,
  type ProcessResult,
  type ProcessRunOptions,
  type ProcessRunResult,
  VaultReindexer,
} from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createServer } from '../server.js';
import type { Services } from '../services.js';

const silentLogger = pino({ level: 'silent' });

/** Fixture-shaped secret, built by concatenation (GitHub push protection). */
const FAKE_SECRET = `${'AKIA'}${'ABCDEFGHIJKLMNOP'}`;

interface FakeRun {
  exitCode: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

interface RecordedRunCall {
  command: string;
  args: string[];
  options?: ProcessRunOptions;
}

/**
 * A ProcessPort whose `run()` outcome is keyed by `args[0]` (the fixture
 * name). N12: records every call's full `options` (`cwd`/`timeoutMs`/`env`)
 * so a test can assert that `verify` actually threads the config's
 * `cwd`/`timeoutSec`/`env` down to `ProcessPort.run` — not just that SOME
 * call happened.
 */
function fakeProcess(
  runs: Record<string, FakeRun> = {},
  recorded?: RecordedRunCall[],
): ProcessPort {
  return {
    async exec(command: string, args: string[]): Promise<ProcessResult> {
      if (command === 'git' && args[0] === 'rev-parse') {
        return { stdout: 'abc1234\n', stderr: '', exitCode: 0 };
      }
      if (command === 'git' && args[0] === 'status') {
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async run(
      command: string,
      args: string[],
      options?: ProcessRunOptions,
    ): Promise<ProcessRunResult> {
      recorded?.push({ command, args, options });
      const key = args[0] ?? '';
      const fixture = runs[key] ?? { exitCode: 0 };
      return {
        stdout: fixture.stdout ?? '',
        stderr: fixture.stderr ?? '',
        exitCode: fixture.exitCode,
        durationMs: 5,
        ...(fixture.timedOut ? { timedOut: true } : {}),
      };
    },
  };
}

function makeServices(
  opts: { files?: Record<string, string>; process?: ProcessPort; withInflight?: boolean } = {},
): Services {
  const files: Record<string, string> = {
    '/vault/.obsidian/app.json': '{}',
    '/ws/chamba/.git/HEAD': 'ref: refs/heads/main\n',
    ...opts.files,
  };
  return {
    fs: new MemoryFilesystem(files),
    process: opts.process ?? fakeProcess(),
    clock: {
      now: () => new Date('2026-11-13T10:00:00Z'),
      today: () => '2026-11-13',
    },
    system: {
      resources: () => ({
        totalMemBytes: 16 * 1024 ** 3,
        freeMemBytes: 8 * 1024 ** 3,
        cpus: 8,
        loadAvg1: 0,
      }),
    },
    http: new FakeParche({
      now: () => new Date('2026-11-13T10:00:00Z'),
      today: () => '2026-11-13',
    }),
    hash: new FakeHash(),
    random: new FakeRandom(),
    cwd: '/ws',
    homedir: '/home/test',
    obsidianVaultPath: '/vault',
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
    metricsMutex: new Map(),
    taskMutex: new Map(),
    metricsSessionId: 'test-session',
    navReadBodyCount: 0,
    workspaceRoot: '/ws',
    platform: 'linux',
    username: 'testuser',
    version: '1.17.0',
  };
}

async function connect(services: Services) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer(silentLogger, services);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

/** O6: no Obsidian vault discoverable, no parche binding — `resolveTaskVault` degrades. */
function makeServicesNoVault(opts: { process?: ProcessPort } = {}): Services {
  const services = makeServices({ process: opts.process });
  return {
    ...services,
    fs: new MemoryFilesystem({ '/ws/chamba/.git/HEAD': 'ref: refs/heads/main\n' }),
    obsidianVaultPath: undefined,
  };
}

function text(result: Awaited<ReturnType<Client['callTool']>>): string {
  const content = result.content as Array<{ type: string; text?: string }>;
  return content.map((c) => c.text ?? '').join('\n');
}

// ─── Test 1: open + immutability + descartado gate ─────────────────────────

describe('Test 1 — open / update / scope_change immutability', () => {
  it('open assigns AC-1..n and is idempotent', async () => {
    const services = makeServices();
    const { client } = await connect(services);

    const first = await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'open',
        workItem: 'CHAMBA-100',
        route: 'small',
        title: 'Título',
        request: 'pedido',
        criteria: ['hace X', 'hace Y'],
      },
    });
    expect(first.isError).toBeFalsy();
    expect(text(first)).toMatch(/AC-1, AC-2/);

    const second = await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'open',
        workItem: 'CHAMBA-100',
        route: 'small',
        criteria: ['otra cosa'],
      },
    });
    expect(second.isError).toBeFalsy();
    expect(text(second)).toMatch(/ya existía/);
  });

  it("update with acUpdates estado='descartado' is rejected, naming scope_change", async () => {
    const services = makeServices();
    const { client } = await connect(services);
    await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'open',
        workItem: 'CHAMBA-101',
        route: 'small',
        criteria: ['hace X'],
      },
    });

    const res = await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'update',
        workItem: 'CHAMBA-101',
        acUpdates: [{ id: 'AC-1', estado: 'descartado' }],
      },
    });
    expect(res.isError).toBeTruthy();
    expect(text(res)).toMatch(/scope_change/);
    expect(text(res)).toMatch(/discard/);
  });

  it("scope_change discard without reason/requestedByUser is rejected; with both, it's the only route to «descartado»", async () => {
    const services = makeServices();
    const { client } = await connect(services);
    await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'open', workItem: 'CHAMBA-102', route: 'small', criteria: ['hace X'] },
    });

    const noReason = await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'scope_change',
        workItem: 'CHAMBA-102',
        change: 'discard',
        acId: 'AC-1',
      },
    });
    expect(noReason.isError).toBeTruthy();

    const noApproval = await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'scope_change',
        workItem: 'CHAMBA-102',
        change: 'discard',
        acId: 'AC-1',
        reason: 'ya no aplica',
      },
    });
    expect(noApproval.isError).toBeTruthy();

    const ok = await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'scope_change',
        workItem: 'CHAMBA-102',
        change: 'discard',
        acId: 'AC-1',
        reason: 'ya no aplica',
        requestedByUser: true,
      },
    });
    expect(ok.isError).toBeFalsy();
  });

  it('update can never change AC text (schema has no field for it)', async () => {
    const services = makeServices();
    const { client } = await connect(services);
    await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'open',
        workItem: 'CHAMBA-103',
        route: 'small',
        criteria: ['texto original'],
      },
    });
    const raw = await services.fs.readFile('/vault/tareas/chamba-103.md');
    expect(raw).toMatch(/texto original/);

    await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'update',
        workItem: 'CHAMBA-103',
        acUpdates: [
          { id: 'AC-1', estado: 'pasa', evidence: ['tareas/chamba-103/evidencia/run-1/x.md'] },
        ],
      },
    });
    const after = await services.fs.readFile('/vault/tareas/chamba-103.md');
    expect(after).toMatch(/texto original/);
  });
});

// ─── Test 2: verify — exit codes, redaction, timeout ───────────────────────

describe('Test 2 — verify', () => {
  it('runs configured commands, records exit codes, and redacts secrets', async () => {
    const config = JSON.stringify({
      version: 1,
      repos: { chamba: { verify: [{ name: 'unit', command: 'node', args: ['pass.js'] }] } },
    });
    const services = makeServices({
      files: {
        '/ws/.chamba/config.json': config,
        '/ws/chamba/.git/HEAD': 'ref: refs/heads/main',
      },
      process: fakeProcess({ 'pass.js': { exitCode: 0, stdout: `token=${FAKE_SECRET}\n` } }),
    });
    const { client } = await connect(services);

    await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'open', workItem: 'CHAMBA-110', route: 'risky', criteria: ['hace X'] },
    });

    const res = await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'verify',
        workItem: 'CHAMBA-110',
        worktreePath: '/ws/chamba',
        repos: ['chamba'],
      },
    });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/1\/1 comando/);

    const evidence = await services.fs.readFile(
      '/vault/tareas/chamba-110/evidencia/run-20261113-01/tests-unit.md',
    );
    expect(evidence).toContain('exit code: 0');
    expect(evidence).not.toContain(FAKE_SECRET);
  });

  it('N12: threads cwd/timeoutSec/env from the config down to ProcessPort.run — not just SOME call', async () => {
    const config = JSON.stringify({
      version: 1,
      repos: {
        chamba: {
          verify: [
            {
              name: 'unit',
              command: 'node',
              args: ['pass.js'],
              cwd: 'sub',
              timeoutSec: 42,
              env: { MY_VAR: 'hola' },
            },
          ],
        },
      },
    });
    const recorded: RecordedRunCall[] = [];
    const services = makeServices({
      files: {
        '/ws/.chamba/config.json': config,
        '/ws/chamba/.git/HEAD': 'ref: refs/heads/main',
        '/ws/chamba/sub/.keep': '',
      },
      process: fakeProcess({ 'pass.js': { exitCode: 0 } }, recorded),
    });
    const { client } = await connect(services);
    await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'open', workItem: 'CHAMBA-112', route: 'risky', criteria: ['hace X'] },
    });
    const res = await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'verify',
        workItem: 'CHAMBA-112',
        worktreePath: '/ws/chamba',
        repos: ['chamba'],
      },
    });
    expect(res.isError).toBeFalsy();
    expect(recorded).toHaveLength(1);
    const call = recorded[0] as RecordedRunCall;
    expect(call.command).toBe('node');
    expect(call.args).toEqual(['pass.js']);
    expect(call.options?.cwd).toBe('/ws/chamba/sub');
    expect(call.options?.timeoutMs).toBe(42_000);
    expect(call.options?.env?.MY_VAR).toBe('hola');
  });

  it('a failing command is reflected in the summary and blocks close', async () => {
    const config = JSON.stringify({
      version: 1,
      repos: { chamba: { verify: [{ name: 'unit', command: 'node', args: ['fail.js'] }] } },
    });
    const services = makeServices({
      files: { '/ws/.chamba/config.json': config },
      process: fakeProcess({ 'fail.js': { exitCode: 1 } }),
    });
    const { client } = await connect(services);
    await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'open', workItem: 'CHAMBA-111', route: 'small', criteria: ['hace X'] },
    });
    const res = await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'verify',
        workItem: 'CHAMBA-111',
        worktreePath: '/ws/chamba',
        repos: ['chamba'],
      },
    });
    expect(text(res)).toMatch(/exit 1/);
  });

  it('NN1: an adapter without run() returns a clear error, never a crash', async () => {
    const services = makeServices({
      process: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    });
    const { client } = await connect(services);
    const res = await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'verify', workItem: 'CHAMBA-112', worktreePath: '/ws/chamba' },
    });
    expect(res.isError).toBeTruthy();
    expect(text(res)).toMatch(/no soporta ejecución con timeout/);
  });

  it('B9: a hostile .chamba/config.json inside the worktree is ignored entirely', async () => {
    const hostile = JSON.stringify({
      version: 1,
      repos: { chamba: { verify: [{ name: 'evil', command: 'node', args: ['evil.js'] }] } },
    });
    const services = makeServices({
      files: { '/ws/chamba/.chamba/config.json': hostile },
      process: fakeProcess({ 'evil.js': { exitCode: 0 } }),
    });
    const { client } = await connect(services);
    const res = await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'verify',
        workItem: 'CHAMBA-113',
        worktreePath: '/ws/chamba',
        repos: ['chamba'],
      },
    });
    expect(res.isError).toBeFalsy();
    // no commands configured in the global/project layers -> reported-by-agent
    expect(text(res)).toMatch(/reportado por el agente/);
  });
});

// ─── Test 3: evidence kind=qa ───────────────────────────────────────────────

describe('Test 3 — evidence', () => {
  it('copies small files and links files that exceed the per-image budget', async () => {
    const bigImage = 'x'.repeat(3 * 1024 * 1024); // 3 MB > 2 MB/image limit
    const services = makeServices({
      files: {
        '/ws/.chamba/qa-evidence/CHAMBA-120/run1/report.md': 'todo bien',
        '/ws/.chamba/qa-evidence/CHAMBA-120/run1/shot.png': bigImage,
      },
    });
    const { client } = await connect(services);
    await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'open', workItem: 'CHAMBA-120', route: 'small', criteria: ['hace X'] },
    });

    const res = await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'evidence',
        workItem: 'CHAMBA-120',
        kind: 'qa',
        sourcePath: '/ws/.chamba/qa-evidence/CHAMBA-120/run1',
      },
    });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/1 archivo\(s\) copiado/);
    expect(text(res)).toMatch(/enlazado/);
  });

  it('B7: report.md with a secret is never copied, and is reported', async () => {
    const services = makeServices({
      files: {
        '/ws/.chamba/qa-evidence/CHAMBA-121/run1/report.md': `leaked=${FAKE_SECRET}`,
      },
    });
    const { client } = await connect(services);
    await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'open', workItem: 'CHAMBA-121', route: 'small', criteria: ['hace X'] },
    });
    const res = await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'evidence',
        workItem: 'CHAMBA-121',
        kind: 'qa',
        sourcePath: '/ws/.chamba/qa-evidence/CHAMBA-121/run1',
      },
    });
    expect(text(res)).toMatch(/report\.md retenido/);
    const exists = await services.fs.exists(
      '/vault/tareas/chamba-121/evidencia/run-20261113-01/qa/report.md',
    );
    expect(exists).toBe(false);
  });

  it('a sourcePath outside the allowed QA roots is rejected', async () => {
    const services = makeServices({ files: { '/tmp/outside/report.md': 'x' } });
    const { client } = await connect(services);
    await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'open', workItem: 'CHAMBA-122', route: 'small', criteria: ['hace X'] },
    });
    const res = await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'evidence',
        workItem: 'CHAMBA-122',
        kind: 'qa',
        sourcePath: '/tmp/outside',
      },
    });
    expect(res.isError).toBeTruthy();
  });
});

// ─── Test 4: close — rejections, partial, happy path ───────────────────────

describe('Test 4 — close', () => {
  async function openSmall(_services: Services, client: Client, workItem: string) {
    await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'open', workItem, route: 'small', criteria: ['AC uno', 'AC dos'] },
    });
  }

  /**
   * B4: `update` now rejects an AC `evidence` ref that doesn't resolve to
   * anything the document tracks or to an existing file under the task's
   * evidence folder — seed a real file instead of the placeholder `'x'`.
   */
  async function seedEvidence(
    services: Services,
    workItem: string,
    name = 'manual.md',
  ): Promise<string> {
    const rel = `tareas/${workItem.toLowerCase()}/evidencia/${name}`;
    await services.fs.mkdir(`/vault/tareas/${workItem.toLowerCase()}/evidencia`);
    await services.fs.writeBytes(`/vault/${rel}`, new TextEncoder().encode('evidencia de prueba'));
    return rel;
  }

  it('rule 1: AC pendiente without reason blocks close', async () => {
    const services = makeServices();
    const { client } = await connect(services);
    await openSmall(services, client, 'CHAMBA-130');
    const res = await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'close', workItem: 'CHAMBA-130' },
    });
    expect(res.isError).toBeTruthy();
    expect(text(res)).toMatch(/no lo rodees/);
    expect(text(res)).toMatch(/pendiente/);
  });

  it('rule 2: AC pasa without evidence blocks close', async () => {
    const services = makeServices();
    const { client } = await connect(services);
    await openSmall(services, client, 'CHAMBA-131');
    await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'update',
        workItem: 'CHAMBA-131',
        acUpdates: [
          { id: 'AC-1', estado: 'pasa' },
          { id: 'AC-2', estado: 'pasa' },
        ],
      },
    });
    const res = await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'close', workItem: 'CHAMBA-131' },
    });
    expect(res.isError).toBeTruthy();
    expect(text(res)).toMatch(/no apunta a ninguna evidencia/);
  });

  it('rule 3: a failing verify run blocks close', async () => {
    const config = JSON.stringify({
      version: 1,
      repos: { chamba: { verify: [{ name: 'unit', command: 'node', args: ['fail.js'] }] } },
    });
    const services = makeServices({
      files: { '/ws/.chamba/config.json': config },
      process: fakeProcess({ 'fail.js': { exitCode: 1 } }),
    });
    const { client } = await connect(services);
    await openSmall(services, client, 'CHAMBA-132');
    const ev132 = await seedEvidence(services, 'CHAMBA-132');
    await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'update',
        workItem: 'CHAMBA-132',
        acUpdates: [
          { id: 'AC-1', estado: 'pasa', evidence: [ev132] },
          { id: 'AC-2', estado: 'pasa', evidence: [ev132] },
        ],
      },
    });
    await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'verify',
        workItem: 'CHAMBA-132',
        worktreePath: '/ws/chamba',
        repos: ['chamba'],
      },
    });
    const res = await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'close', workItem: 'CHAMBA-132' },
    });
    expect(res.isError).toBeTruthy();
    expect(text(res)).toMatch(/falló/);
  });

  it('rule 4 (O2): risky route with no repos.<repo>.verify configured blocks close', async () => {
    const services = makeServices();
    const { client } = await connect(services);
    await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'open', workItem: 'CHAMBA-133', route: 'risky', criteria: ['AC uno'] },
    });
    const ev133 = await seedEvidence(services, 'CHAMBA-133');
    await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'update',
        workItem: 'CHAMBA-133',
        acUpdates: [{ id: 'AC-1', estado: 'pasa', evidence: [ev133] }],
      },
    });
    const res = await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'close', workItem: 'CHAMBA-133', repos: ['chamba'] },
    });
    expect(res.isError).toBeTruthy();
    expect(text(res)).toMatch(/no tiene repos\.chamba\.verify configurado/);
  });

  it('rule 5 (B2): an AC en «falla» blocks close, but partial+approvedByUser exempts it', async () => {
    const services = makeServices();
    const { client } = await connect(services);
    await openSmall(services, client, 'CHAMBA-134');
    const ev134 = await seedEvidence(services, 'CHAMBA-134');
    await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'update',
        workItem: 'CHAMBA-134',
        acUpdates: [
          { id: 'AC-1', estado: 'falla', reason: 'no compiló' },
          { id: 'AC-2', estado: 'pasa', evidence: [ev134] },
        ],
      },
    });
    const blocked = await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'close', workItem: 'CHAMBA-134' },
    });
    expect(blocked.isError).toBeTruthy();

    const partialNoApproval = await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'close', workItem: 'CHAMBA-134', partial: true },
    });
    expect(partialNoApproval.isError).toBeTruthy();

    const partialApproved = await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'close', workItem: 'CHAMBA-134', partial: true, approvedByUser: true },
    });
    expect(partialApproved.isError).toBeFalsy();
    const partialStructured = partialApproved.structuredContent as Record<string, unknown>;
    expect(partialStructured.closeBlockMarkdown as string).toMatch(
      /cierre parcial aprobado por el usuario/,
    );
    const doc = await services.fs.readFile('/vault/tareas/chamba-134.md');
    expect(doc).toMatch(/cierre parcial aprobado por el usuario/);
    expect(doc).toMatch(/2026-11-13/);
  });

  it('rule 6 (B2): a descartado AC with no scope_change entry blocks close EVEN with partial', async () => {
    // Pure unit coverage of rule 6 itself (no hand-edit needed) lives in
    // core/src/tasks/close-gate.test.ts — `evaluateCloseGate` is given a
    // `descartado` AC with no matching `discard` entry directly.
    const services = makeServices();
    const { client } = await connect(services);
    await openSmall(services, client, 'CHAMBA-135');
    await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'scope_change',
        workItem: 'CHAMBA-135',
        change: 'discard',
        acId: 'AC-1',
        reason: 'no aplica',
        requestedByUser: true,
      },
    });
    const ev135 = await seedEvidence(services, 'CHAMBA-135');
    await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'update',
        workItem: 'CHAMBA-135',
        acUpdates: [{ id: 'AC-2', estado: 'pasa', evidence: [ev135] }],
      },
    });

    // partial+approvedByUser exempts rules 1-5 but NEVER rule 6 — AC-1 is
    // legitimately discarded WITH a matching scope_change entry here, so
    // this should close cleanly; rule 6's "no registro" path is exercised
    // at the pure close-gate level (see above).
    const res = await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'close', workItem: 'CHAMBA-135', partial: true, approvedByUser: true },
    });
    expect(res.isError).toBeFalsy();
  });

  it('N1: a hand-edit of the criteria/evidence/scope-changes blocks between writes blocks close', async () => {
    // These three blocks are the ones ONLY chamba may rewrite — a digest
    // (`chamba_digest` in the frontmatter) is stamped on every write and
    // re-checked on every read; a hand-edit (even one that looks "valid",
    // like dropping a scope_changes entry) is rejected before the close
    // gate's own rules ever run.
    const services = makeServices();
    const { client } = await connect(services);
    await openSmall(services, client, 'CHAMBA-138');
    await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'scope_change',
        workItem: 'CHAMBA-138',
        change: 'discard',
        acId: 'AC-1',
        reason: 'no aplica',
        requestedByUser: true,
      },
    });
    const path = '/vault/tareas/chamba-138.md';
    const raw = await services.fs.readFile(path);
    const corrupted = raw.replace(
      /<!-- chamba:task:scope_changes:start -->[\s\S]*?<!-- chamba:task:scope_changes:end -->/,
      '<!-- chamba:task:scope_changes:start -->\n<!-- chamba:task:scope_changes:end -->',
    );
    await services.fs.writeBytes(path, new TextEncoder().encode(corrupted));

    const res = await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'close', workItem: 'CHAMBA-138', partial: true, approvedByUser: true },
    });
    expect(res.isError).toBeTruthy();
    expect(text(res)).toMatch(/editado a mano/);

    // `get` reports the violation instead of hard-blocking.
    const getRes = await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'get', workItem: 'CHAMBA-138' },
    });
    expect(getRes.isError).toBeFalsy();
    expect((getRes.structuredContent as Record<string, unknown>).integrityViolation).toBe(true);
  });

  it('happy close produces Implementado/Verificado/Pendiente and taskEvidence that end() uses', async () => {
    const config = JSON.stringify({
      version: 1,
      repos: { chamba: { verify: [{ name: 'unit', command: 'node', args: ['pass.js'] }] } },
    });
    const services = makeServices({
      files: { '/ws/.chamba/config.json': config },
      process: fakeProcess({ 'pass.js': { exitCode: 0 } }),
    });
    const { client } = await connect(services);

    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: {
        action: 'start',
        workItem: 'CHAMBA-136',
        routeSuggested: 'small',
        source: 'ticket',
      },
    });
    await openSmall(services, client, 'CHAMBA-136');
    const verifyRes = await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'verify',
        workItem: 'CHAMBA-136',
        worktreePath: '/ws/chamba',
        repos: ['chamba'],
      },
    });
    const verifyStructured = verifyRes.structuredContent as {
      run: { commands: Array<{ evidencePath: string }> };
    };
    const evidencePath136 = verifyStructured.run.commands[0]?.evidencePath as string;
    await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'update',
        workItem: 'CHAMBA-136',
        acUpdates: [
          { id: 'AC-1', estado: 'pasa', evidence: [evidencePath136] },
          { id: 'AC-2', estado: 'pasa', evidence: [evidencePath136] },
        ],
      },
    });

    const closeRes = await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'close', workItem: 'CHAMBA-136' },
    });
    expect(closeRes.isError).toBeFalsy();
    const structured = closeRes.structuredContent as Record<string, unknown>;
    expect(structured.testsPassed).toBe(true);
    expect(structured.delivered).toBe(true);
    expect(typeof structured.closeBlockMarkdown).toBe('string');
    expect(structured.closeBlockMarkdown as string).toMatch(/### Implementado/);
    expect(structured.closeBlockMarkdown as string).toMatch(/### Verificado/);
    expect(structured.closeBlockMarkdown as string).toMatch(/### Pendiente/);

    // end() must prefer close's measured facts, not the agent's own claim.
    const endRes = await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'end', workItem: 'CHAMBA-136', testsPassed: false, delivered: false },
    });
    expect(endRes.isError).toBeFalsy();
    expect(text(endRes)).toMatch(/Entregado: sí/);
    expect(text(endRes)).toMatch(/medido por chamba_task close/);
  });

  it('N9: close without an active inflight still writes the document and says so', async () => {
    const services = makeServices();
    const { client } = await connect(services);
    await openSmall(services, client, 'CHAMBA-137');
    const ev137 = await seedEvidence(services, 'CHAMBA-137');
    await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'update',
        workItem: 'CHAMBA-137',
        acUpdates: [
          { id: 'AC-1', estado: 'pasa', evidence: [ev137] },
          { id: 'AC-2', estado: 'pasa', evidence: [ev137] },
        ],
      },
    });
    const res = await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'close', workItem: 'CHAMBA-137' },
    });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/no hay métricas activas/);
    const doc = await services.fs.readFile('/vault/tareas/chamba-137.md');
    expect(doc).toMatch(/cerrada/);
  });
});

// ─── Test 5: resume (get) ───────────────────────────────────────────────────

describe('Test 5 — get / resume', () => {
  it('reconstructs siguientePaso, the gate result, and worktreePath', async () => {
    const services = makeServices();
    const { client } = await connect(services);
    await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'open',
        workItem: 'CHAMBA-140',
        route: 'small',
        criteria: ['AC uno'],
        worktreePath: '/ws/chamba',
      },
    });
    const res = await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'get', workItem: 'CHAMBA-140' },
    });
    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.worktreePath).toBe('/ws/chamba');
    expect(typeof structured.siguientePaso).toBe('string');
    expect(structured.siguientePaso as string).toMatch(/AC-1/);
    // N12: AC-1 is still `pendiente` with no reason — the close gate must
    // say so, not just "be defined".
    const compuerta = structured.compuerta as { ok: boolean; missing?: string[] };
    expect(compuerta.ok).toBe(false);
    expect(compuerta.missing?.[0]).toMatch(/pendiente/);
  });
});

// ─── Test 6: trivial route ──────────────────────────────────────────────────

describe('Test 6 — trivial route', () => {
  it('open on trivial creates no document', async () => {
    const services = makeServices();
    const { client } = await connect(services);
    const res = await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'open', workItem: 'CHAMBA-150', route: 'trivial' },
    });
    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.document).toBeNull();
    expect(structured.route).toBe('trivial');
    const exists = await services.fs.exists('/vault/tareas/chamba-150.md');
    expect(exists).toBe(false);
  });

  it('verify without a document still returns blockMarkdown with exit codes', async () => {
    const config = JSON.stringify({
      version: 1,
      repos: { chamba: { verify: [{ name: 'unit', command: 'node', args: ['pass.js'] }] } },
    });
    const services = makeServices({
      files: { '/ws/.chamba/config.json': config },
      process: fakeProcess({ 'pass.js': { exitCode: 0 } }),
    });
    const { client } = await connect(services);
    const res = await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'verify',
        workItem: 'CHAMBA-151',
        worktreePath: '/ws/chamba',
        repos: ['chamba'],
      },
    });
    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.document).toBeNull();
    expect(typeof structured.blockMarkdown).toBe('string');
    expect(structured.blockMarkdown as string).toMatch(/1\/1 comando/);
  });
});

// ─── O6: no vault configured — verify/close degrade, never crash ──────────

describe('O6 — no vault configured', () => {
  it('verify still runs and returns a blockMarkdown (no document to persist into)', async () => {
    const config = JSON.stringify({
      version: 1,
      repos: { chamba: { verify: [{ name: 'unit', command: 'node', args: ['pass.js'] }] } },
    });
    const services = makeServicesNoVault({ process: fakeProcess({ 'pass.js': { exitCode: 0 } }) });
    const { client } = await connect(services);
    await services.fs.writeBytes('/ws/.chamba/config.json', new TextEncoder().encode(config));
    const res = await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'verify',
        workItem: 'CHAMBA-180',
        worktreePath: '/ws/chamba',
        repos: ['chamba'],
      },
    });
    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.document).toBeNull();
    expect(structured.blockMarkdown as string).toMatch(/1\/1 comando/);
  });

  it('open degrades with a notice instead of erroring', async () => {
    const services = makeServicesNoVault();
    const { client } = await connect(services);
    const res = await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'open', workItem: 'CHAMBA-181', route: 'small', criteria: ['AC uno'] },
    });
    expect(res.isError).toBeFalsy();
    expect(text(res)).toMatch(/sin vault/);
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.document).toBeNull();
  });

  it('close gives a clear notice every time, never a silent no-op or a crash', async () => {
    const services = makeServicesNoVault();
    const { client } = await connect(services);
    const res = await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'close', workItem: 'CHAMBA-182' },
    });
    expect(res.isError).toBeTruthy();
    expect(text(res)).toMatch(/sin vault/);
    // Calling it again gives the SAME clear notice, not a different failure mode.
    const res2 = await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'close', workItem: 'CHAMBA-182' },
    });
    expect(res2.isError).toBeTruthy();
    expect(text(res2)).toMatch(/sin vault/);
  });
});

// ─── hot-path (D-2, plan §9) ─────────────────────────────────────────────────
// `chamba_task` never uses `VaultWriter`; reindex only happens from `open`
// and `close`. 10 consecutive `update` calls over a non-trivial vault
// (500 unrelated notes) must make ZERO calls to `VaultReindexer.reindex` —
// spied on the PROTOTYPE (never via spread, per the CHAMBA-024 lesson), so
// the spy sees every call regardless of which instance `reindexTaskVault`
// constructs internally.

describe('hot-path — chamba_task update never reindexes (D-2)', () => {
  it('10 consecutive updates make 0 calls to VaultReindexer.reindex', async () => {
    const services = makeServices();
    for (let i = 0; i < 500; i++) {
      await services.fs.writeFile(
        `/vault/proyectos/nota-${i}.md`,
        `---\ntitle: nota ${i}\ntype: nota\n---\n# nota ${i}\n`,
      );
    }
    const { client } = await connect(services);

    const reindexSpy = vi.spyOn(VaultReindexer.prototype, 'reindex');

    const opened = await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'open',
        workItem: 'CHAMBA-170',
        route: 'risky',
        criteria: ['hace X'],
      },
    });
    expect(opened.isError).toBeFalsy();
    expect(reindexSpy).toHaveBeenCalledTimes(1); // open reindexes once
    reindexSpy.mockClear();

    for (let i = 0; i < 10; i++) {
      const res = await client.callTool({
        name: 'chamba_task',
        arguments: {
          action: 'update',
          workItem: 'CHAMBA-170',
          progress: `avance ${i}`,
          nextStep: `siguiente paso ${i}`,
        },
      });
      expect(res.isError).toBeFalsy();
    }

    expect(reindexSpy).toHaveBeenCalledTimes(0);
    reindexSpy.mockRestore();
  });
});

// ─── MCP server never writes to stdout ──────────────────────────────────────

describe('stdout hygiene', () => {
  it('chamba_task never writes to stdout', async () => {
    const spy = vi_spyOnStdout();
    const services = makeServices();
    const { client } = await connect(services);
    await client.callTool({
      name: 'chamba_task',
      arguments: { action: 'open', workItem: 'CHAMBA-160', route: 'small', criteria: ['x'] },
    });
    expect(spy.calls).toHaveLength(0);
    spy.restore();
  });
});

function vi_spyOnStdout(): { calls: unknown[]; restore: () => void } {
  const calls: unknown[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    calls.push(chunk);
    return true;
  }) as typeof process.stdout.write;
  return {
    calls,
    restore: () => {
      process.stdout.write = original;
    },
  };
}
