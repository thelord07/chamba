/**
 * task-phases.test.ts — CHAMBA-024 (T1)
 *
 * Reductor puro: nowIso pasado como argumento, sin reloj propio. Determinismo
 * total.
 */
import { describe, expect, it } from 'vitest';
import {
  applyPhaseEvent,
  closeOpenSpans,
  emptyPhaseState,
  normalizeWorkItemId,
  type PhaseState,
  WORK_ITEM_REGEX,
} from './task-phases.js';

const T0 = '2026-11-07T10:00:00Z';

function at(seconds: number): string {
  return new Date(Date.parse(T0) + seconds * 1000).toISOString();
}

describe('applyPhaseEvent', () => {
  it('(a) secuencia feliz context→plan→implement→test→close con ms exactos', () => {
    let state: PhaseState = emptyPhaseState();
    state = { ...state, activePhase: { phase: 'context', startedAt: at(0) } };

    state = applyPhaseEvent(state, { kind: 'phase_start', phase: 'plan' }, at(10)).state;
    expect(state.phases.context).toEqual({ ms: 10_000, count: 1, inferred: true });

    state = applyPhaseEvent(state, { kind: 'phase_end', phase: 'plan' }, at(25)).state;
    expect(state.phases.plan).toEqual({ ms: 15_000, count: 1 });

    state = applyPhaseEvent(state, { kind: 'phase_start', phase: 'implement' }, at(25)).state;
    state = applyPhaseEvent(state, { kind: 'phase_end', phase: 'implement' }, at(45)).state;
    expect(state.phases.implement).toEqual({ ms: 20_000, count: 1 });

    state = applyPhaseEvent(state, { kind: 'phase_start', phase: 'test' }, at(45)).state;
    state = applyPhaseEvent(state, { kind: 'phase_end', phase: 'test' }, at(50)).state;
    expect(state.phases.test).toEqual({ ms: 5_000, count: 1 });

    state = applyPhaseEvent(state, { kind: 'phase_start', phase: 'close' }, at(50)).state;
    state = closeOpenSpans(state, at(55));
    expect(state.phases.close).toEqual({ ms: 5_000, count: 1, inferred: true });
    expect(state.activePhase).toBeUndefined();
  });

  it('(b) phase_start sin phase_end previo → la anterior queda inferred', () => {
    let state: PhaseState = {
      ...emptyPhaseState(),
      activePhase: { phase: 'plan', startedAt: at(0) },
    };
    const { state: next, note } = applyPhaseEvent(
      state,
      { kind: 'phase_start', phase: 'implement' },
      at(10),
    );
    expect(next.phases.plan).toEqual({ ms: 10_000, count: 1, inferred: true });
    expect(note).toBeUndefined();
    state = next;
  });

  it('(c) closeOpenSpans con fase abierta → cerrada inferred', () => {
    const state: PhaseState = {
      ...emptyPhaseState(),
      activePhase: { phase: 'qa', startedAt: at(0) },
    };
    const closed = closeOpenSpans(state, at(7));
    expect(closed.phases.qa).toEqual({ ms: 7_000, count: 1, inferred: true });
    expect(closed.activePhase).toBeUndefined();
  });

  it('(d) 2 rondas de review suman ms y count', () => {
    let state: PhaseState = emptyPhaseState();
    state = applyPhaseEvent(state, { kind: 'phase_start', phase: 'review' }, at(0)).state;
    state = applyPhaseEvent(state, { kind: 'phase_end', phase: 'review' }, at(5)).state;
    state = applyPhaseEvent(state, { kind: 'phase_start', phase: 'review' }, at(10)).state;
    state = applyPhaseEvent(state, { kind: 'phase_end', phase: 'review' }, at(18)).state;
    expect(state.phases.review).toEqual({ ms: 13_000, count: 2 });
  });

  it('(e) phase_end con fase que no coincide → cierra la activa inferida, nota, no error', () => {
    const state: PhaseState = {
      ...emptyPhaseState(),
      activePhase: { phase: 'plan', startedAt: at(0) },
    };
    const { state: next, note } = applyPhaseEvent(
      state,
      { kind: 'phase_end', phase: 'implement' },
      at(5),
    );
    expect(next.phases.plan).toEqual({ ms: 5_000, count: 1, inferred: true });
    expect(next.activePhase).toBeUndefined();
    expect(note).toBeDefined();
  });

  it('(f) nowIso anterior a startedAt → delta clamped a 0', () => {
    const state: PhaseState = {
      ...emptyPhaseState(),
      activePhase: { phase: 'plan', startedAt: at(10) },
    };
    const { state: next } = applyPhaseEvent(state, { kind: 'phase_end', phase: 'plan' }, at(0));
    expect(next.phases.plan).toEqual({ ms: 0, count: 1 });
  });

  it('(g) tool_span no altera ms ni count', () => {
    let state: PhaseState = emptyPhaseState();
    state = applyPhaseEvent(state, { kind: 'tool_span', phase: 'setup', ms: 3_000 }, at(0)).state;
    expect(state.phases.setup).toEqual({ ms: 0, count: 0, toolMs: 3_000, toolCount: 1 });
    state = applyPhaseEvent(state, { kind: 'tool_span', phase: 'setup', ms: 2_000 }, at(0)).state;
    expect(state.phases.setup).toEqual({ ms: 0, count: 0, toolMs: 5_000, toolCount: 2 });
  });

  it('(h) invariante: suma de ms de fases disjuntas <= wall', () => {
    let state: PhaseState = {
      ...emptyPhaseState(),
      activePhase: { phase: 'context', startedAt: at(0) },
    };
    state = applyPhaseEvent(state, { kind: 'phase_start', phase: 'plan' }, at(10)).state;
    state = applyPhaseEvent(state, { kind: 'phase_start', phase: 'implement' }, at(20)).state;
    const final = closeOpenSpans(state, at(30));
    const sum = Object.values(final.phases).reduce((s, p) => s + (p?.ms ?? 0), 0);
    expect(sum).toBeLessThanOrEqual(30_000);
    expect(sum).toBe(30_000); // disjuntas y contiguas → igualdad
  });

  it('human_wait_start/end suma por motivo (S1: dentro de la fase activa también)', () => {
    let state: PhaseState = {
      ...emptyPhaseState(),
      activePhase: { phase: 'plan', startedAt: at(0) },
    };
    state = applyPhaseEvent(
      state,
      { kind: 'human_wait_start', reason: 'clarification' },
      at(5),
    ).state;
    state = applyPhaseEvent(state, { kind: 'human_wait_end' }, at(15)).state;
    expect(state.humanWaits).toEqual({
      count: 1,
      ms: 10_000,
      byReason: { clarification: { count: 1, ms: 10_000 } },
    });
    expect(state.phases.plan?.humanWaitMs).toBe(10_000);
  });

  it('human_wait_start anidado cierra el anterior como inferred', () => {
    let state: PhaseState = emptyPhaseState();
    state = applyPhaseEvent(
      state,
      { kind: 'human_wait_start', reason: 'clarification' },
      at(0),
    ).state;
    state = applyPhaseEvent(
      state,
      { kind: 'human_wait_start', reason: 'risky_confirm' },
      at(5),
    ).state;
    expect(state.humanWaits.byReason.clarification).toEqual({
      count: 1,
      ms: 5_000,
      inferred: true,
    });
    expect(state.activeHumanWait).toEqual({ reason: 'risky_confirm', startedAt: at(5) });
  });

  it('final_review cerrada por closeOpenSpans: count cuenta, ms === 0 (S7)', () => {
    let state: PhaseState = emptyPhaseState();
    state = applyPhaseEvent(
      state,
      { kind: 'human_wait_start', reason: 'final_review' },
      at(0),
    ).state;
    const closed = closeOpenSpans(state, at(0));
    expect(closed.humanWaits.byReason.final_review).toEqual({ count: 1, ms: 0, inferred: true });
  });
});

describe('applyPhaseEvent — M1 (CHAMBA-022 review de CHAMBA-024): phase_start repetido', () => {
  it('un phase_start de la MISMA fase ya abierta no la cierra ni la reabre', () => {
    let state: PhaseState = emptyPhaseState();
    state = applyPhaseEvent(state, { kind: 'phase_start', phase: 'context' }, at(0)).state;
    const second = applyPhaseEvent(state, { kind: 'phase_start', phase: 'context' }, at(5));
    expect(second.note).toMatch(/se ignora el phase_start repetido/);
    state = second.state;
    state = applyPhaseEvent(state, { kind: 'phase_end', phase: 'context' }, at(10)).state;
    // Un solo tramo real: count 1, sin `inferred`.
    expect(state.phases.context).toEqual({ ms: 10_000, count: 1 });
  });

  it('phase_start A seguido de phase_start B sigue cerrando A como inferred (no-regresión)', () => {
    let state: PhaseState = emptyPhaseState();
    state = applyPhaseEvent(state, { kind: 'phase_start', phase: 'context' }, at(0)).state;
    state = applyPhaseEvent(state, { kind: 'phase_start', phase: 'plan' }, at(10)).state;
    expect(state.phases.context).toEqual({ ms: 10_000, count: 1, inferred: true });
    expect(state.activePhase).toEqual({ phase: 'plan', startedAt: at(10) });
  });
});

describe('normalizeWorkItemId', () => {
  it('normaliza case e insensibiliza separadores', () => {
    expect(normalizeWorkItemId('CHAMBA-024')).toBe('chamba-024');
    expect(normalizeWorkItemId('chamba_024')).toBe('chamba-024');
    expect(normalizeWorkItemId('--CHAMBA.024--')).toBe('chamba-024');
  });
});

describe('WORK_ITEM_REGEX', () => {
  it('acepta IDs alfanuméricos con guiones y puntos', () => {
    expect(WORK_ITEM_REGEX.test('CHAMBA-024')).toBe(true);
    expect(WORK_ITEM_REGEX.test('orq-20261107T153010Z')).toBe(true);
  });
  it('rechaza texto libre con espacios', () => {
    expect(WORK_ITEM_REGEX.test('not a valid id')).toBe(false);
  });
});
