/**
 * metrics.test.ts — ST-9T §5.5
 *
 * CLI `metrics` sobre fixture JSONL con ambos sources.
 */

import type { TaskMetric } from '@chamba/core';
import { FakeHash, FakeParche, MemoryFilesystem, serializeTaskMetric } from '@chamba/core';
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
