import { describe, expect, it } from 'vitest';
import { computeNextStep } from './next-step.js';
import type { TaskDoc } from './task-doc.js';

function doc(overrides: Partial<TaskDoc> = {}): TaskDoc {
  return {
    workItem: 'CHAMBA-022',
    title: 'x',
    route: 'risky',
    request: 'x',
    criteria: [],
    checklist: [],
    progressLog: [],
    nextStep: '',
    scopeChanges: [],
    verifyRuns: [],
    evidence: [],
    estadoTarea: 'en_progreso',
    ...overrides,
  };
}

describe('computeNextStep', () => {
  it('prioritizes a pendiente AC first', () => {
    const step = computeNextStep(
      doc({ criteria: [{ id: 'AC-1', text: 'x', estado: 'pendiente', evidence: [] }] }),
    );
    expect(step).toMatch(/AC-1/);
    expect(step).toMatch(/pendiente/);
  });

  it('then a failing verify command', () => {
    const step = computeNextStep(
      doc({
        criteria: [{ id: 'AC-1', text: 'x', estado: 'pasa', evidence: ['e.md'] }],
        verifyRuns: [
          {
            runId: 'r1',
            date: '2026-11-13',
            level: 'executed',
            commands: [
              { name: 'unit', exitCode: 1, timedOut: false, truncated: false, durationMs: 1 },
            ],
          },
        ],
      }),
    );
    expect(step).toMatch(/verify/);
    expect(step).toMatch(/unit/);
  });

  it('then missing evidence on a passing AC', () => {
    const step = computeNextStep(
      doc({ criteria: [{ id: 'AC-1', text: 'x', estado: 'pasa', evidence: [] }] }),
    );
    expect(step).toMatch(/verify/i); // no run yet → ask for verify before closing
  });

  it('then an AC in falla (once verify has actually run and did not itself fail)', () => {
    const step = computeNextStep(
      doc({
        criteria: [{ id: 'AC-1', text: 'x', estado: 'falla', evidence: [] }],
        verifyRuns: [
          {
            runId: 'r1',
            date: '2026-11-13',
            level: 'executed',
            commands: [
              { name: 'unit', exitCode: 0, timedOut: false, truncated: false, durationMs: 1 },
            ],
          },
        ],
      }),
    );
    expect(step).toMatch(/AC-1/);
    expect(step).toMatch(/falla/);
  });

  it('finally: ready to close', () => {
    const step = computeNextStep(
      doc({ criteria: [{ id: 'AC-1', text: 'x', estado: 'pasa', evidence: ['e.md'] }] }),
    );
    expect(step).toMatch(/cerrar/);
  });

  it('is deterministic for the same doc', () => {
    const d = doc({ criteria: [{ id: 'AC-1', text: 'x', estado: 'pendiente', evidence: [] }] });
    expect(computeNextStep(d)).toBe(computeNextStep(d));
  });
});
