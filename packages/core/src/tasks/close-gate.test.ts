import { describe, expect, it } from 'vitest';
import { type CloseGateInput, evaluateCloseGate } from './close-gate.js';

function baseInput(overrides: Partial<CloseGateInput> = {}): CloseGateInput {
  return {
    route: 'substantial',
    criteria: [{ id: 'AC-1', text: 'x', estado: 'pasa', evidence: ['tareas/x/evidencia/e.md'] }],
    scopeChanges: [],
    reposWithVerifyConfigured: [],
    reposTouched: [],
    knownEvidencePaths: ['tareas/x/evidencia/e.md'],
    ...overrides,
  };
}

describe('evaluateCloseGate — happy path', () => {
  it('passes when every AC is pasa with evidence and no verify failures', () => {
    const result = evaluateCloseGate(baseInput());
    expect(result).toEqual({ ok: true, partial: false, pending: [] });
  });
});

describe('evaluateCloseGate — rule 1: pendiente sin razón', () => {
  it('blocks', () => {
    const result = evaluateCloseGate(
      baseInput({ criteria: [{ id: 'AC-1', text: 'x', estado: 'pendiente', evidence: [] }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected blocked');
    expect(result.missing[0]).toBe('AC-1 sigue pendiente y no tiene razón registrada.');
  });

  it('does not block a pendiente AC that has a registered reason', () => {
    const result = evaluateCloseGate(
      baseInput({
        criteria: [{ id: 'AC-1', text: 'x', estado: 'pendiente', evidence: [], reason: 'motivo' }],
      }),
    );
    expect(result).toEqual({ ok: true, partial: false, pending: [] });
  });
});

describe('evaluateCloseGate — rule 2: pasa sin evidencia', () => {
  it('blocks', () => {
    const result = evaluateCloseGate(
      baseInput({ criteria: [{ id: 'AC-1', text: 'x', estado: 'pasa', evidence: [] }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected blocked');
    expect(result.missing[0]).toBe('AC-1 dice «pasa» pero no apunta a ninguna evidencia.');
  });
});

describe('evaluateCloseGate — rule 2 (B4): pasa con evidencia no resuelta', () => {
  it('blocks when the AC evidence path is not in knownEvidencePaths', () => {
    const result = evaluateCloseGate(
      baseInput({
        criteria: [
          { id: 'AC-1', text: 'x', estado: 'pasa', evidence: ['tareas/x/evidencia/nope.md'] },
        ],
        knownEvidencePaths: ['tareas/x/evidencia/e.md'],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected blocked');
    expect(result.missing[0]).toMatch(/no resuelve a nada registrado/);
  });

  it('passes when the AC evidence path IS in knownEvidencePaths', () => {
    const result = evaluateCloseGate(baseInput());
    expect(result).toEqual({ ok: true, partial: false, pending: [] });
  });
});

describe('evaluateCloseGate — rule 3: último verify falló', () => {
  it('blocks on non-zero exit', () => {
    const result = evaluateCloseGate(
      baseInput({
        lastVerifyRun: {
          runId: 'run-1',
          date: '2026-11-13',
          level: 'executed',
          commands: [
            { name: 'test', exitCode: 1, timedOut: false, truncated: false, durationMs: 10 },
          ],
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected blocked');
    expect(result.missing[0]).toBe('verify «test» falló (exit 1).');
  });

  it('blocks on timeout even with exit 0', () => {
    const result = evaluateCloseGate(
      baseInput({
        lastVerifyRun: {
          runId: 'run-1',
          date: '2026-11-13',
          level: 'executed',
          commands: [
            { name: 'test', exitCode: 0, timedOut: true, truncated: false, durationMs: 10 },
          ],
        },
      }),
    );
    expect(result.ok).toBe(false);
  });

  it('does not block on truncated output alone (B4 — informative, never a failure)', () => {
    const result = evaluateCloseGate(
      baseInput({
        lastVerifyRun: {
          runId: 'run-1',
          date: '2026-11-13',
          level: 'executed',
          commands: [
            { name: 'test', exitCode: 0, timedOut: false, truncated: true, durationMs: 10 },
          ],
        },
      }),
    );
    expect(result).toEqual({ ok: true, partial: false, pending: [] });
  });

  it('B1 defense-in-depth: blocks when the last run is bound to a different worktree than the document', () => {
    const result = evaluateCloseGate(
      baseInput({
        documentWorktreePath: '/ws/CHAMBA-022/chamba',
        lastVerifyRun: {
          runId: 'run-1',
          date: '2026-11-13',
          level: 'executed',
          commands: [
            { name: 'test', exitCode: 0, timedOut: false, truncated: false, durationMs: 10 },
          ],
          worktreePath: '/ws/OTHER-TICKET/chamba',
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected blocked');
    expect(result.missing[0]).toMatch(/no corresponde al worktree/);
  });
});

describe('evaluateCloseGate — rule 4 (O2): risky sin verify configurado', () => {
  it('blocks only in risky', () => {
    const result = evaluateCloseGate(
      baseInput({ route: 'risky', reposTouched: ['chamba'], reposWithVerifyConfigured: [] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected blocked');
    expect(result.missing[0]).toMatch(/repos\.chamba\.verify/);
  });

  it('does not block in substantial/small', () => {
    const result = evaluateCloseGate(
      baseInput({
        route: 'substantial',
        reposTouched: ['chamba'],
        reposWithVerifyConfigured: [],
      }),
    );
    expect(result).toEqual({ ok: true, partial: false, pending: [] });
  });

  it('does not block when the touched repo HAS verify configured', () => {
    const result = evaluateCloseGate(
      baseInput({
        route: 'risky',
        reposTouched: ['chamba'],
        reposWithVerifyConfigured: ['chamba'],
      }),
    );
    expect(result).toEqual({ ok: true, partial: false, pending: [] });
  });

  it('B2: blocks in risky when NO repo could be determined at all', () => {
    const result = evaluateCloseGate(
      baseInput({ route: 'risky', reposTouched: [], reposWithVerifyConfigured: [] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected blocked');
    expect(result.missing[0]).toMatch(/no puedo determinar qué repo tocó/);
  });

  it('B2: the undetermined-repo block is exemptable via partial + approvedByUser', () => {
    const result = evaluateCloseGate(
      baseInput({
        route: 'risky',
        reposTouched: [],
        reposWithVerifyConfigured: [],
        partial: true,
        approvedByUser: true,
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('evaluateCloseGate — rule 5 (B2): AC en falla', () => {
  it('blocks', () => {
    const result = evaluateCloseGate(
      baseInput({ criteria: [{ id: 'AC-1', text: 'x', estado: 'falla', evidence: [] }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected blocked');
    expect(result.missing[0]).toBe('AC-1 está en «falla»: no se puede cerrar como entregado.');
  });

  it('is exempted by partial + approvedByUser', () => {
    const result = evaluateCloseGate(
      baseInput({
        criteria: [{ id: 'AC-1', text: 'x', estado: 'falla', evidence: [] }],
        partial: true,
        approvedByUser: true,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.partial).toBe(true);
    expect(result.pending).toContain('AC-1 está en «falla»: no se puede cerrar como entregado.');
  });
});

describe('evaluateCloseGate — rule 6 (B2): AC descartado sin registro', () => {
  it('blocks even though "descartado" is not pendiente/pasa/falla', () => {
    const result = evaluateCloseGate(
      baseInput({ criteria: [{ id: 'AC-1', text: 'x', estado: 'descartado', evidence: [] }] }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected blocked');
    expect(result.missing[0]).toBe(
      'AC-1 figura descartado pero no hay registro de quién lo pidió ni por qué.',
    );
  });

  it('passes when a matching discard entry exists', () => {
    const result = evaluateCloseGate(
      baseInput({
        criteria: [{ id: 'AC-1', text: 'x', estado: 'descartado', evidence: [] }],
        scopeChanges: [
          {
            date: '2026-11-13',
            change: 'discard',
            acId: 'AC-1',
            reason: 'motivo',
            requestedByUser: true,
          },
        ],
      }),
    );
    expect(result).toEqual({ ok: true, partial: false, pending: [] });
  });

  it('STILL blocks even with partial+approvedByUser (B2: partial cannot exempt rule 6)', () => {
    const result = evaluateCloseGate(
      baseInput({
        criteria: [{ id: 'AC-1', text: 'x', estado: 'descartado', evidence: [] }],
        partial: true,
        approvedByUser: true,
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected blocked');
    expect(result.missing).toContain(
      'AC-1 figura descartado pero no hay registro de quién lo pidió ni por qué.',
    );
  });
});

describe('evaluateCloseGate — partial semantics (O3)', () => {
  it('partial without approvedByUser is an error telling the agent to ask the human', () => {
    const result = evaluateCloseGate(baseInput({ partial: true }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected blocked');
    expect(result.missing[0]).toMatch(/aprobación/);
  });

  it('partial + approvedByUser exempts rules 1-5 and lists them as pending', () => {
    const result = evaluateCloseGate(
      baseInput({
        criteria: [
          { id: 'AC-1', text: 'x', estado: 'pendiente', evidence: [] },
          { id: 'AC-2', text: 'y', estado: 'pasa', evidence: [] },
        ],
        partial: true,
        approvedByUser: true,
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.partial).toBe(true);
    expect(result.pending).toHaveLength(2);
  });
});
