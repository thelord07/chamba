/**
 * phase-summary.test.ts — CHAMBA-024 (T3, T3c)
 */
import { describe, expect, it } from 'vitest';
import { summarizePhases } from './phase-summary.js';
import type { TaskMetric } from './task-metrics.js';

function metric(overrides: Partial<TaskMetric>): TaskMetric {
  return {
    workItem: 'T-1',
    startedAt: '2026-11-01T08:00:00Z',
    endedAt: '2026-11-01T09:00:00Z',
    routeSuggested: 'small',
    routeFinal: 'small',
    overridden: false,
    escalations: 0,
    planReviewRounds: 0,
    verifyRounds: 0,
    notesRead: 0,
    testsPassed: true,
    delivered: true,
    source: 'ticket',
    ...overrides,
  };
}

describe('summarizePhases', () => {
  it('fases + unaccounted suman exactamente 100%', () => {
    const metrics: TaskMetric[] = [
      metric({
        workItem: 'A',
        startedAt: '2026-11-01T08:00:00Z',
        endedAt: '2026-11-01T08:10:00Z', // wall = 600_000ms
        phases: { plan: { ms: 200_000, count: 1 }, implement: { ms: 300_000, count: 1 } },
      }),
    ];
    const report = summarizePhases(metrics, { route: 'small' });
    const group = report.byRoute[0];
    expect(group).toBeDefined();
    const total =
      (group?.phases.reduce((s, p) => s + p.pctOfTotal, 0) ?? 0) +
      (group?.unaccounted.pctOfTotal ?? 0);
    expect(total).toBeCloseTo(100, 5);
  });

  it('calcula medianas y p90 (nearest-rank) sobre tickets con esa fase', () => {
    const metrics: TaskMetric[] = [1, 2, 3, 4, 5].map((n) =>
      metric({
        workItem: `T-${n}`,
        startedAt: '2026-11-01T08:00:00Z',
        endedAt: '2026-11-01T08:10:00Z',
        phases: { plan: { ms: n * 1000, count: 1 } },
      }),
    );
    const report = summarizePhases(metrics, { route: 'small' });
    const planStat = report.byRoute[0]?.phases.find((p) => p.phase === 'plan');
    expect(planStat?.medianMs).toBe(3000);
    // nearest-rank p90 of [1000,2000,3000,4000,5000] n=5: ceil(0.9*5)-1 = 4 → 5000
    expect(planStat?.p90Ms).toBe(5000);
  });

  it('marca la fase dominante, o unaccounted si es mayor', () => {
    const metrics: TaskMetric[] = [
      metric({
        workItem: 'A',
        startedAt: '2026-11-01T08:00:00Z',
        endedAt: '2026-11-01T08:10:00Z', // 600_000
        phases: { plan: { ms: 50_000, count: 1 } }, // resto (550_000) sin fase → unaccounted domina
      }),
    ];
    const report = summarizePhases(metrics, { route: 'small' });
    const group = report.byRoute[0];
    expect(group?.unaccounted.dominant).toBe(true);
    expect(group?.phases.every((p) => !p.dominant)).toBe(true);
  });

  it('2 ticket(s) sin desglose se cuentan aparte', () => {
    const metrics: TaskMetric[] = [
      metric({ workItem: 'A', phases: { plan: { ms: 1000, count: 1 } } }),
      metric({ workItem: 'B' }),
      metric({ workItem: 'C' }),
    ];
    const report = summarizePhases(metrics);
    expect(report.withoutBreakdown).toBe(2);
  });

  it('T3c: jsonl editado a mano se ignora y cuenta en malformed, sin NaN', () => {
    const raw: TaskMetric[] = [
      { ...metric({ workItem: 'bad1' }), phases: 'nope' } as unknown as TaskMetric,
      {
        ...metric({ workItem: 'bad2' }),
        phases: { implement: { ms: 'x', count: null } },
      } as unknown as TaskMetric,
      {
        ...metric({ workItem: 'bad3' }),
        phases: { noExiste: { ms: 5, count: 1 } },
      } as unknown as TaskMetric,
      {
        ...metric({ workItem: 'bad4' }),
        phases: { implement: { ms: Number.NaN, count: 1 } },
      } as unknown as TaskMetric,
      {
        ...metric({ workItem: 'bad5' }),
        phases: { implement: { ms: -5, count: 1 } },
      } as unknown as TaskMetric,
      {
        ...metric({ workItem: 'bad6' }),
        phases: { implement: { ms: Number.POSITIVE_INFINITY, count: 1 } },
      } as unknown as TaskMetric,
    ];
    const report = summarizePhases(raw);
    expect(report.malformed).toBe(6);
    for (const group of report.byRoute) {
      for (const p of group.phases) {
        expect(Number.isNaN(p.medianMs)).toBe(false);
        expect(Number.isNaN(p.pctOfTotal)).toBe(false);
      }
    }
  });

  it('accountedMs > wallMs → inconsistent, excluido de medianas', () => {
    const metrics: TaskMetric[] = [
      metric({
        workItem: 'bad',
        startedAt: '2026-11-01T08:00:00Z',
        endedAt: '2026-11-01T08:00:01Z', // wall = 1000ms
        phases: { plan: { ms: 999_999, count: 1 } }, // accounted >> wall
      }),
    ];
    const report = summarizePhases(metrics, { route: 'small' });
    expect(report.inconsistent).toBe(1);
    expect(report.byRoute).toHaveLength(0);
  });
});

describe('summarizePhases — CHAMBA-024 review ronda 1 (B1, inconsistent global, wallSum=0)', () => {
  it('B1: final_review se cuenta (count) aunque esté inferida, con medianMs n/d', () => {
    const metrics: TaskMetric[] = [
      metric({
        workItem: 'A',
        routeFinal: 'small',
        humanWaits: {
          count: 1,
          ms: 0,
          byReason: { final_review: { count: 1, ms: 0, inferred: true } },
        },
      }),
      metric({
        workItem: 'B',
        routeFinal: 'small',
        humanWaits: {
          count: 1,
          ms: 0,
          byReason: { final_review: { count: 1, ms: 0, inferred: true } },
        },
      }),
    ];
    const report = summarizePhases(metrics, { route: 'small' });
    const finalReview = report.byRoute[0]?.humanWaits.byReason.find(
      (r) => r.reason === 'final_review',
    );
    expect(finalReview).toBeDefined();
    expect(finalReview?.count).toBe(2); // Σ entry.count, NO Σ tickets-con-muestra
    expect(finalReview?.unmeasurable).toBe(true);
  });

  it('B1: una fase con pausas reales no pierde su conteo por tener además una inferida', () => {
    const metrics: TaskMetric[] = [
      // Ticket con 2 pausas de clarification: una real (5000ms) y una inferida
      // (el reductor marca inferred=true de forma sticky para todo el agregado).
      metric({
        workItem: 'A',
        routeFinal: 'small',
        humanWaits: {
          count: 2,
          ms: 5000,
          byReason: { clarification: { count: 2, ms: 5000, inferred: true } },
        },
      }),
      // Ticket con 1 pausa real medible, sin inferencia.
      metric({
        workItem: 'B',
        routeFinal: 'small',
        humanWaits: {
          count: 1,
          ms: 3000,
          byReason: { clarification: { count: 1, ms: 3000, inferred: false } },
        },
      }),
    ];
    const report = summarizePhases(metrics, { route: 'small' });
    const clarification = report.byRoute[0]?.humanWaits.byReason.find(
      (r) => r.reason === 'clarification',
    );
    expect(clarification?.count).toBe(3); // 2 + 1, cuenta completa
    expect(clarification?.medianMs).toBe(3000); // solo la muestra NO inferida
    expect(clarification?.unmeasurable).toBe(false);
  });

  it('AC-8b/T4e: "Por ticket" trae pauses y blockedMs', () => {
    const metrics: TaskMetric[] = [
      metric({
        workItem: 'A',
        routeFinal: 'small',
        humanWaits: {
          count: 2,
          ms: 12_000,
          byReason: { clarification: { count: 2, ms: 12_000, inferred: false } },
        },
      }),
    ];
    const report = summarizePhases(metrics, { route: 'small' });
    expect(report.perTicket).toEqual([
      expect.objectContaining({ workItem: 'A', pauses: 2, blockedMs: 12_000 }),
    ]);
  });

  it('inconsistent se cuenta globalmente, no después del filtro por ruta', () => {
    const metrics: TaskMetric[] = [
      metric({
        workItem: 'bad-small',
        routeFinal: 'small',
        startedAt: '2026-11-01T08:00:00Z',
        endedAt: '2026-11-01T08:00:01Z',
        phases: { plan: { ms: 999_999, count: 1 } },
      }),
      metric({
        workItem: 'bad-risky',
        routeFinal: 'risky',
        startedAt: '2026-11-01T08:00:00Z',
        endedAt: '2026-11-01T08:00:01Z',
        phases: { plan: { ms: 999_999, count: 1 } },
      }),
    ];
    // Filtrando solo por "small" el inconsistent global sigue contando ambos.
    const report = summarizePhases(metrics, { route: 'small' });
    expect(report.inconsistent).toBe(2);
  });

  it('perTicket excluye los tickets inconsistentes', () => {
    const metrics: TaskMetric[] = [
      metric({
        workItem: 'bad',
        routeFinal: 'small',
        startedAt: '2026-11-01T08:00:00Z',
        endedAt: '2026-11-01T08:00:01Z',
        phases: { plan: { ms: 999_999, count: 1 } },
      }),
      metric({
        workItem: 'good',
        routeFinal: 'small',
        startedAt: '2026-11-01T08:00:00Z',
        endedAt: '2026-11-01T08:10:00Z',
        phases: { plan: { ms: 1000, count: 1 } },
      }),
    ];
    const report = summarizePhases(metrics);
    expect(report.perTicket.map((t) => t.workItem)).toEqual(['good']);
  });

  it('wallSum === 0 → ninguna fase ni unaccounted se marca dominante', () => {
    const metrics: TaskMetric[] = [
      metric({
        workItem: 'A',
        routeFinal: 'small',
        startedAt: '2026-11-01T08:00:00Z',
        endedAt: '2026-11-01T08:00:00Z', // wall = 0
        phases: { plan: { ms: 0, count: 1 } },
      }),
    ];
    const report = summarizePhases(metrics, { route: 'small' });
    const group = report.byRoute[0];
    expect(group?.unaccounted.dominant).toBe(false);
    expect(group?.phases.every((p) => !p.dominant)).toBe(true);
  });
});
