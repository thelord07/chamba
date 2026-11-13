/**
 * metrics.test.ts — ST-9T §5.5
 *
 * CLI `metrics` sobre fixture JSONL con ambos sources.
 */

import type { TaskMetric } from '@chamba/core';
import {
  FakeHash,
  FakeParche,
  FakeRandom,
  MemoryFilesystem,
  serializeTaskMetric,
} from '@chamba/core';
import { describe, expect, it, vi } from 'vitest';
import type { Services } from '../services.js';
import { type MetricsCliDeps, runMetricsCli } from './metrics.js';

function makeMetric(overrides: Partial<TaskMetric>): TaskMetric {
  return {
    workItem: 'TEST-001',
    startedAt: '2026-11-01T08:00:00Z',
    endedAt: '2026-11-01T10:00:00Z',
    routeSuggested: 'small',
    routeFinal: 'small',
    overridden: false,
    escalations: 0,
    planReviewRounds: 0,
    verifyRounds: 1,
    notesRead: 2,
    testsPassed: true,
    delivered: true,
    source: 'ticket',
    ...overrides,
  };
}

const FIXTURE_METRICS: TaskMetric[] = [
  makeMetric({ workItem: 'T1', routeFinal: 'small', source: 'ticket', delivered: true }),
  makeMetric({
    workItem: 'T2',
    routeFinal: 'small',
    source: 'ticket',
    delivered: false,
    escalations: 1,
  }),
  makeMetric({
    workItem: 'T3',
    routeFinal: 'risky',
    source: 'ticket',
    delivered: true,
    planReviewRounds: 2,
    verifyRounds: 2,
  }),
  makeMetric({ workItem: 'orq-001', routeFinal: 'small', source: 'orq', delivered: true }),
  makeMetric({ workItem: 'orq-002', routeFinal: 'substantial', source: 'orq', delivered: true }),
];

const FIXTURE_JSONL = FIXTURE_METRICS.map(serializeTaskMetric).join('');

function makeDeps(files?: Record<string, string>): MetricsCliDeps & { captured: string[] } {
  const captured: string[] = [];
  const services: Services = {
    fs: new MemoryFilesystem(files ?? {}),
    process: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    clock: { now: () => new Date('2026-11-07T12:00:00Z'), today: () => '2026-11-07' },
    system: {
      resources: () => ({
        totalMemBytes: 16 * 1024 ** 3,
        freeMemBytes: 8 * 1024 ** 3,
        cpus: 8,
        loadAvg1: 0,
      }),
    },
    http: new FakeParche({
      now: () => new Date('2026-11-07T12:00:00Z'),
      today: () => '2026-11-07',
    }),
    hash: new FakeHash(),
    random: new FakeRandom(),
    cwd: '/proj',
    homedir: '/home/test',
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
    platform: 'linux',
    username: 'testuser',
  };
  return {
    captured,
    services,
    stdout: (msg: string) => captured.push(msg),
    stderr: (msg: string) => captured.push(`STDERR: ${msg}`),
    exit: vi.fn(),
  };
}

describe('runMetricsCli', () => {
  it('shows "Sin métricas" when no tasks.jsonl exists', async () => {
    const deps = makeDeps();
    await runMetricsCli([], deps);
    const output = deps.captured.join('\n');
    expect(output).toContain('Sin métricas');
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('renders table with both sources from fixture', async () => {
    const deps = makeDeps({ '/proj/.chamba/metrics/tasks.jsonl': FIXTURE_JSONL });
    await runMetricsCli([], deps);
    const output = deps.captured.join('\n');

    // Should have source labels
    expect(output).toContain('[ticket]');
    expect(output).toContain('[orq]');
    expect(output).toContain('[total]');

    // Should have route names
    expect(output).toContain('small');
    expect(output).toContain('risky');
    expect(output).toContain('substantial');

    // Headers
    expect(output).toContain('Ruta');

    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('shows ticket count in header', async () => {
    const deps = makeDeps({ '/proj/.chamba/metrics/tasks.jsonl': FIXTURE_JSONL });
    await runMetricsCli([], deps);
    const output = deps.captured.join('\n');
    expect(output).toContain('5'); // 5 total tickets
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('--since filters old metrics', async () => {
    // Add an old metric and a recent one
    const old = makeMetric({
      workItem: 'OLD',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T02:00:00Z',
    });
    const recent = makeMetric({
      workItem: 'RECENT',
      startedAt: '2026-11-01T00:00:00Z',
      endedAt: '2026-11-01T02:00:00Z',
    });
    const jsonl = serializeTaskMetric(old) + serializeTaskMetric(recent);

    const deps = makeDeps({ '/proj/.chamba/metrics/tasks.jsonl': jsonl });
    await runMetricsCli(['--since', '30d'], deps);
    const output = deps.captured.join('\n');

    // OLD should be filtered out (from January 2026)
    // RECENT from November 2026 should be within 30d of "now" (2026-11-07)
    expect(output).not.toContain('Sin métricas'); // at least RECENT is there
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('--since with invalid format → error', async () => {
    const deps = makeDeps({ '/proj/.chamba/metrics/tasks.jsonl': FIXTURE_JSONL });
    await runMetricsCli(['--since', 'invalid'], deps);
    const output = deps.captured.join('\n');
    expect(output).toContain('STDERR:');
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('shows workspace root in output', async () => {
    const deps = makeDeps({ '/proj/.chamba/metrics/tasks.jsonl': FIXTURE_JSONL });
    await runMetricsCli([], deps);
    const output = deps.captured.join('\n');
    expect(output).toContain('/proj');
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('handles empty tasks.jsonl gracefully', async () => {
    const deps = makeDeps({ '/proj/.chamba/metrics/tasks.jsonl': '\n\n' });
    await runMetricsCli([], deps);
    expect(deps.exit).toHaveBeenCalledWith(0);
  });
});

describe('runMetricsCli — CHAMBA-024 --phases', () => {
  const PHASE_FIXTURE: TaskMetric[] = [
    makeMetric({
      workItem: 'P1',
      routeFinal: 'small',
      startedAt: '2026-11-01T08:00:00Z',
      endedAt: '2026-11-01T08:10:00Z',
      phases: { plan: { ms: 240_000, count: 1 }, implement: { ms: 180_000, count: 1 } },
    }),
    makeMetric({
      workItem: 'P2',
      routeFinal: 'small',
      startedAt: '2026-11-02T08:00:00Z',
      endedAt: '2026-11-02T08:20:00Z',
      phases: { plan: { ms: 300_000, count: 1 }, implement: { ms: 600_000, count: 1 } },
    }),
    // 2 líneas sin phases (sin desglose, retrocompat con 1.15.1)
    makeMetric({ workItem: 'NO1', routeFinal: 'small' }),
    makeMetric({ workItem: 'NO2', routeFinal: 'small' }),
  ];
  const PHASE_JSONL = PHASE_FIXTURE.map(serializeTaskMetric).join('');

  it('T3: muestra medianas, p90, %total y fase dominante; 2 sin desglose', async () => {
    const deps = makeDeps({ '/proj/.chamba/metrics/tasks.jsonl': PHASE_JSONL });
    await runMetricsCli(['--phases'], deps);
    const output = deps.captured.join('\n');
    expect(output).toContain('plan');
    expect(output).toContain('implement');
    expect(output).toContain('2 ticket(s) sin desglose');
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('--route small filtra', async () => {
    const deps = makeDeps({ '/proj/.chamba/metrics/tasks.jsonl': PHASE_JSONL });
    await runMetricsCli(['--phases', '--route', 'small'], deps);
    const output = deps.captured.join('\n');
    expect(output).toContain('[small]');
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('--route basura → exit 1', async () => {
    const deps = makeDeps({ '/proj/.chamba/metrics/tasks.jsonl': PHASE_JSONL });
    await runMetricsCli(['--phases', '--route', 'basura'], deps);
    const output = deps.captured.join('\n');
    expect(output).toContain('STDERR:');
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('un caso donde unaccounted es la dominante y el render lo dice', async () => {
    const dominated: TaskMetric = makeMetric({
      workItem: 'U1',
      routeFinal: 'small',
      startedAt: '2026-11-01T08:00:00Z',
      endedAt: '2026-11-01T08:10:00Z', // 600_000ms
      phases: { plan: { ms: 10_000, count: 1 } }, // resto sin fase domina
    });
    const deps = makeDeps({ '/proj/.chamba/metrics/tasks.jsonl': serializeTaskMetric(dominated) });
    await runMetricsCli(['--phases'], deps);
    const output = deps.captured.join('\n');
    expect(output).toContain('dominante: sin fase / traspasos');
  });
});

describe('runMetricsCli — AC-8b/T4e: bloque "Pausas al humano" + "Por ticket"', () => {
  it('cuenta pausas por motivo (final_review n/d) y lista "Por ticket" con pauses/blockedMs', async () => {
    const withWaits: TaskMetric[] = [
      makeMetric({
        workItem: 'W1',
        routeFinal: 'small',
        startedAt: '2026-11-01T08:00:00Z',
        endedAt: '2026-11-01T08:10:00Z',
        phases: { plan: { ms: 60_000, count: 1 } },
        humanWaits: {
          count: 2,
          ms: 10_000,
          byReason: {
            clarification: { count: 1, ms: 10_000, inferred: false },
            final_review: { count: 1, ms: 0, inferred: true },
          },
        },
      }),
      makeMetric({
        workItem: 'W2',
        routeFinal: 'small',
        startedAt: '2026-11-02T08:00:00Z',
        endedAt: '2026-11-02T08:10:00Z',
        phases: { plan: { ms: 60_000, count: 1 } },
        humanWaits: {
          count: 1,
          ms: 0,
          byReason: { final_review: { count: 1, ms: 0, inferred: true } },
        },
      }),
    ];
    const jsonl = withWaits.map(serializeTaskMetric).join('');
    const deps = makeDeps({ '/proj/.chamba/metrics/tasks.jsonl': jsonl });
    await runMetricsCli(['--phases'], deps);
    const output = deps.captured.join('\n');

    expect(output).toContain('Pausas al humano');
    // final_review: 2 pausas totales (Σ entry.count across both tickets), n/d
    expect(output).toMatch(/final_review:\s*2\s*\(mediana n\/d\)/);
    // clarification: 1 pausa medible, mediana 10s
    expect(output).toMatch(/clarification:\s*1\s*\(mediana 10s\)/);

    expect(output).toContain('Por ticket:');
    expect(output).toMatch(/W1.*pausas=2.*bloqueado=10s/);
    expect(output).toMatch(/W2.*pausas=1.*bloqueado=0s/);
  });
});

describe('runMetricsCli — T3b: salida por defecto idéntica a 1.15.1', () => {
  it('es byte a byte idéntica sobre el fixture existente', async () => {
    const deps = makeDeps({ '/proj/.chamba/metrics/tasks.jsonl': FIXTURE_JSONL });
    await runMetricsCli([], deps);
    const output = deps.captured.join('\n');
    expect(output).toMatchInlineSnapshot(`
      "Métricas de tareas — /proj
      Total: 5 ticket(s)

      ---------------------------------------------------------------------------------------------------
      Fuente    Ruta         Tickets  Duración md  Avg plan  Avg verify  %entregado  %escalado  %override
      ---------------------------------------------------------------------------------------------------
      [ticket]
      ticket    small              2         2.0h       0.0         1.0         50%        50%         0%
      ticket    risky              1         2.0h       2.0         2.0        100%         0%         0%

      [orq]
      orq       small              1         2.0h       0.0         1.0        100%         0%         0%
      orq       substantial        1         2.0h       0.0         1.0        100%         0%         0%

      [total]
      total     small              3         2.0h       0.0         1.0         67%        33%         0%
      total     substantial        1         2.0h       0.0         1.0        100%         0%         0%
      total     risky              1         2.0h       2.0         2.0        100%         0%         0%
      ---------------------------------------------------------------------------------------------------"
    `);
  });
});

describe('runMetricsCli — T3d: parseo de flags', () => {
  it('--since --phases → exit 1 ("falta el valor de --since")', async () => {
    const deps = makeDeps({ '/proj/.chamba/metrics/tasks.jsonl': FIXTURE_JSONL });
    await runMetricsCli(['--since', '--phases'], deps);
    const output = deps.captured.join('\n');
    expect(output).toContain('falta el valor de --since');
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('--since final sin valor → exit 1', async () => {
    const deps = makeDeps({ '/proj/.chamba/metrics/tasks.jsonl': FIXTURE_JSONL });
    await runMetricsCli(['--since'], deps);
    expect(deps.exit).toHaveBeenCalledWith(1);
  });

  it('--route sin valor → exit 1', async () => {
    const deps = makeDeps({ '/proj/.chamba/metrics/tasks.jsonl': FIXTURE_JSONL });
    await runMetricsCli(['--route'], deps);
    expect(deps.exit).toHaveBeenCalledWith(1);
  });
});

describe('runMetricsCli — win32 (cheap cross-platform case)', () => {
  it('resolves and renders correctly with Windows-style cwd/homedir', async () => {
    const wsRoot = 'C:\\proj';
    const jsonlPath = `${wsRoot}/.chamba/metrics/tasks.jsonl`; // joinPath always uses "/" internally
    const deps: MetricsCliDeps & { captured: string[] } = {
      ...makeDeps(),
      services: {
        ...makeDeps().services,
        fs: new MemoryFilesystem({ [jsonlPath]: FIXTURE_JSONL }),
        cwd: wsRoot,
        homedir: 'C:\\Users\\test',
        platform: 'win32',
      },
    };
    await runMetricsCli([], deps);
    const output = deps.captured.join('\n');
    expect(output).toContain('[ticket]');
    expect(deps.exit).toHaveBeenCalledWith(0);
  });
});
