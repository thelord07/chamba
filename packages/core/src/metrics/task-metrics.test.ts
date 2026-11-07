/**
 * task-metrics.test.ts — ST-3T
 *
 * Cobertura: línea estable, parse tolerante, reductor + render sobre fixture, filtro since.
 */

import { describe, expect, it } from 'vitest';
import type { TaskMetric } from './task-metrics.js';
import {
  filterMetricsSince,
  parseSinceArg,
  parseTaskMetricsJsonl,
  renderMetricsTable,
  serializeTaskMetric,
  summarizeMetricsByRoute,
} from './task-metrics.js';

const BASE_METRIC: TaskMetric = {
  workItem: 'CHAMBA-001',
  startedAt: '2026-11-01T10:00:00Z',
  endedAt: '2026-11-01T11:30:00Z',
  routeSuggested: 'small',
  routeFinal: 'small',
  overridden: false,
  escalations: 0,
  planReviewRounds: 0,
  verifyRounds: 1,
  notesRead: 3,
  testsPassed: true,
  delivered: true,
  source: 'ticket',
};

describe('serializeTaskMetric', () => {
  it('serializes to JSON + newline', () => {
    const line = serializeTaskMetric(BASE_METRIC);
    expect(line.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(line.trim()) as TaskMetric;
    expect(parsed.workItem).toBe('CHAMBA-001');
    expect(parsed.source).toBe('ticket');
  });

  it('round-trips correctly', () => {
    const line = serializeTaskMetric(BASE_METRIC);
    const [result] = parseTaskMetricsJsonl(line);
    expect(result).toEqual(BASE_METRIC);
  });

  it('produces stable output for same input', () => {
    const a = serializeTaskMetric(BASE_METRIC);
    const b = serializeTaskMetric(BASE_METRIC);
    expect(a).toBe(b);
  });
});

describe('parseTaskMetricsJsonl', () => {
  it('parses multiple valid lines', () => {
    const m1: TaskMetric = { ...BASE_METRIC, workItem: 'T1' };
    const m2: TaskMetric = { ...BASE_METRIC, workItem: 'T2', source: 'orq' };
    const raw = serializeTaskMetric(m1) + serializeTaskMetric(m2);
    const parsed = parseTaskMetricsJsonl(raw);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.workItem).toBe('T1');
    expect(parsed[1]?.workItem).toBe('T2');
    expect(parsed[1]?.source).toBe('orq');
  });

  it('tolerates empty lines', () => {
    const raw = `\n\n${serializeTaskMetric(BASE_METRIC)}\n\n`;
    expect(parseTaskMetricsJsonl(raw)).toHaveLength(1);
  });

  it('tolerates malformed JSON lines', () => {
    const raw = `this is not json\n${serializeTaskMetric(BASE_METRIC)}`;
    const parsed = parseTaskMetricsJsonl(raw);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.workItem).toBe('CHAMBA-001');
  });

  it('tolerates \\r\\n line endings (Windows)', () => {
    const raw = `${JSON.stringify(BASE_METRIC)}\r\n`;
    expect(parseTaskMetricsJsonl(raw)).toHaveLength(1);
  });

  it('ignores objects missing required fields', () => {
    const invalid = `${JSON.stringify({ workItem: 'X' })}\n`;
    expect(parseTaskMetricsJsonl(invalid)).toHaveLength(0);
  });

  it('returns empty array for empty string', () => {
    expect(parseTaskMetricsJsonl('')).toHaveLength(0);
  });
});

describe('parseSinceArg', () => {
  it('parses 30d', () => {
    const d = parseSinceArg('30d');
    expect(d).toBeInstanceOf(Date);
    const diff = Date.now() - (d?.getTime() ?? 0);
    expect(diff).toBeGreaterThan(29 * 86400 * 1000);
    expect(diff).toBeLessThan(31 * 86400 * 1000);
  });

  it('parses 24h', () => {
    const d = parseSinceArg('24h');
    const diff = Date.now() - (d?.getTime() ?? 0);
    expect(diff).toBeGreaterThan(23 * 3600 * 1000);
    expect(diff).toBeLessThan(25 * 3600 * 1000);
  });

  it('parses 2w', () => {
    const d = parseSinceArg('2w');
    const diff = Date.now() - (d?.getTime() ?? 0);
    expect(diff).toBeGreaterThan(13 * 86400 * 1000);
    expect(diff).toBeLessThan(15 * 86400 * 1000);
  });

  it('returns null for invalid input', () => {
    expect(parseSinceArg('invalid')).toBeNull();
    expect(parseSinceArg('')).toBeNull();
    expect(parseSinceArg('abc')).toBeNull();
  });
});

describe('filterMetricsSince', () => {
  const old: TaskMetric = { ...BASE_METRIC, workItem: 'OLD', startedAt: '2026-01-01T00:00:00Z' };
  const recent: TaskMetric = {
    ...BASE_METRIC,
    workItem: 'RECENT',
    startedAt: '2026-10-30T00:00:00Z',
  };

  it('filters out old metrics', () => {
    const since = new Date('2026-10-01T00:00:00Z');
    const filtered = filterMetricsSince([old, recent], since);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.workItem).toBe('RECENT');
  });

  it('includes metrics exactly at since', () => {
    const since = new Date('2026-10-30T00:00:00Z');
    expect(filterMetricsSince([recent], since)).toHaveLength(1);
  });
});

// ── Fixture for summarize + render ─────────────────────────────────────────────

function makeMetric(overrides: Partial<TaskMetric>): TaskMetric {
  return { ...BASE_METRIC, ...overrides };
}

const FIXTURE: TaskMetric[] = [
  // ticket/small × 3
  makeMetric({
    workItem: 'T1',
    routeFinal: 'small',
    source: 'ticket',
    delivered: true,
    escalations: 0,
    overridden: false,
    planReviewRounds: 0,
    verifyRounds: 1,
    startedAt: '2026-11-01T08:00:00Z',
    endedAt: '2026-11-01T09:00:00Z',
  }),
  makeMetric({
    workItem: 'T2',
    routeFinal: 'small',
    source: 'ticket',
    delivered: true,
    escalations: 0,
    overridden: false,
    planReviewRounds: 0,
    verifyRounds: 2,
    startedAt: '2026-11-02T08:00:00Z',
    endedAt: '2026-11-02T10:00:00Z',
  }),
  makeMetric({
    workItem: 'T3',
    routeFinal: 'small',
    source: 'ticket',
    delivered: false,
    escalations: 1,
    overridden: true,
    planReviewRounds: 1,
    verifyRounds: 1,
    startedAt: '2026-11-03T08:00:00Z',
    endedAt: '2026-11-03T11:00:00Z',
  }),
  // ticket/risky × 1
  makeMetric({
    workItem: 'T4',
    routeFinal: 'risky',
    source: 'ticket',
    delivered: true,
    escalations: 0,
    overridden: false,
    planReviewRounds: 2,
    verifyRounds: 2,
    startedAt: '2026-11-04T08:00:00Z',
    endedAt: '2026-11-04T16:00:00Z',
  }),
  // orq/small × 2
  makeMetric({
    workItem: 'orq-001',
    routeFinal: 'small',
    source: 'orq',
    delivered: true,
    escalations: 0,
    overridden: false,
    planReviewRounds: 0,
    verifyRounds: 1,
    startedAt: '2026-11-05T08:00:00Z',
    endedAt: '2026-11-05T09:30:00Z',
  }),
  makeMetric({
    workItem: 'orq-002',
    routeFinal: 'small',
    source: 'orq',
    delivered: true,
    escalations: 0,
    overridden: false,
    planReviewRounds: 0,
    verifyRounds: 1,
    startedAt: '2026-11-06T08:00:00Z',
    endedAt: '2026-11-06T10:00:00Z',
  }),
];

describe('summarizeMetricsByRoute', () => {
  it('separates by source and route', () => {
    const { bySource, total } = summarizeMetricsByRoute(FIXTURE);

    // ticket/small
    const ticketSmall = bySource.find((r) => r.source === 'ticket' && r.route === 'small');
    expect(ticketSmall).toBeDefined();
    expect(ticketSmall?.tickets).toBe(3);

    // ticket/risky
    const ticketRisky = bySource.find((r) => r.source === 'ticket' && r.route === 'risky');
    expect(ticketRisky).toBeDefined();
    expect(ticketRisky?.tickets).toBe(1);

    // orq/small
    const orqSmall = bySource.find((r) => r.source === 'orq' && r.route === 'small');
    expect(orqSmall).toBeDefined();
    expect(orqSmall?.tickets).toBe(2);

    // total/small = 3 + 2 = 5
    const totalSmall = total.find((r) => r.route === 'small');
    expect(totalSmall?.tickets).toBe(5);
  });

  it('computes pctDelivered correctly', () => {
    const { bySource } = summarizeMetricsByRoute(FIXTURE);
    // biome-ignore lint/style/noNonNullAssertion: test fixture guarantees entry exists
    const ticketSmall = bySource.find((r) => r.source === 'ticket' && r.route === 'small')!;
    // 2 of 3 delivered → 67%
    expect(ticketSmall.pctDelivered).toBe(67);
  });

  it('computes pctEscalated correctly', () => {
    const { bySource } = summarizeMetricsByRoute(FIXTURE);
    // biome-ignore lint/style/noNonNullAssertion: test fixture guarantees entry exists
    const ticketSmall = bySource.find((r) => r.source === 'ticket' && r.route === 'small')!;
    // 1 of 3 escalated → 33%
    expect(ticketSmall.pctEscalated).toBe(33);
  });

  it('computes avgPlanRounds (planReviewRounds 0 for small → 0.0)', () => {
    const { bySource } = summarizeMetricsByRoute(FIXTURE);
    // biome-ignore lint/style/noNonNullAssertion: test fixture guarantees entry exists
    const orqSmall = bySource.find((r) => r.source === 'orq' && r.route === 'small')!;
    expect(orqSmall.avgPlanRounds).toBe(0);
  });

  it('computes medianDurationSec', () => {
    const { bySource } = summarizeMetricsByRoute(FIXTURE);
    // biome-ignore lint/style/noNonNullAssertion: test fixture guarantees entry exists
    const ticketSmall = bySource.find((r) => r.source === 'ticket' && r.route === 'small')!;
    // durations: 3600, 7200, 10800 → median = 7200
    expect(ticketSmall.medianDurationSec).toBe(7200);
  });

  it('returns empty arrays for no metrics', () => {
    const { bySource, total } = summarizeMetricsByRoute([]);
    expect(bySource).toHaveLength(0);
    expect(total).toHaveLength(0);
  });
});

describe('renderMetricsTable', () => {
  it('returns "Sin métricas" for empty input', () => {
    const output = renderMetricsTable(summarizeMetricsByRoute([]));
    expect(output).toContain('Sin métricas');
  });

  it('renders source labels', () => {
    const output = renderMetricsTable(summarizeMetricsByRoute(FIXTURE));
    expect(output).toContain('[ticket]');
    expect(output).toContain('[orq]');
    expect(output).toContain('[total]');
  });

  it('renders route names', () => {
    const output = renderMetricsTable(summarizeMetricsByRoute(FIXTURE));
    expect(output).toContain('small');
    expect(output).toContain('risky');
  });

  it('renders column headers', () => {
    const output = renderMetricsTable(summarizeMetricsByRoute(FIXTURE));
    expect(output).toContain('Ruta');
    expect(output).toContain('Tickets');
    expect(output).toContain('Avg plan');
    expect(output).toContain('Avg verify');
    expect(output).toContain('%entregado');
  });
});
