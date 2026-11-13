import { describe, expect, it } from 'vitest';
import { applyScopeChange } from './scope-change.js';
import type { TaskDoc } from './task-doc.js';

function baseDoc(overrides: Partial<TaskDoc> = {}): TaskDoc {
  return {
    workItem: 'CHAMBA-022',
    title: 'Título',
    route: 'risky',
    request: 'pedido',
    criteria: [
      { id: 'AC-1', text: 'Hacer X', estado: 'pasa', evidence: ['tareas/x.md'] },
      { id: 'AC-2', text: 'Hacer Y', estado: 'falla', evidence: [] },
    ],
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

describe('applyScopeChange — add', () => {
  it('appends AC-n+1 and an append-only scope-change entry', () => {
    const result = applyScopeChange(baseDoc(), {
      change: 'add',
      date: '2026-11-13',
      text: 'Hacer Z',
      reason: 'alcance nuevo',
      requestedByUser: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.doc.criteria.at(-1)).toEqual({
      id: 'AC-3',
      text: 'Hacer Z',
      estado: 'pendiente',
      evidence: [],
    });
    expect(result.doc.scopeChanges).toHaveLength(1);
    expect(result.doc.scopeChanges[0]?.change).toBe('add');
  });

  it('rejects add without text', () => {
    const result = applyScopeChange(baseDoc(), { change: 'add', date: '2026-11-13' });
    expect(result.ok).toBe(false);
  });

  it('never rewrites the text of an existing AC', () => {
    const doc = baseDoc();
    const result = applyScopeChange(doc, {
      change: 'add',
      date: '2026-11-13',
      text: 'Nuevo',
    });
    if (!result.ok) throw new Error('expected ok');
    expect(result.doc.criteria[0]?.text).toBe(doc.criteria[0]?.text);
    expect(result.doc.criteria[1]?.text).toBe(doc.criteria[1]?.text);
  });
});

describe('applyScopeChange — reopen', () => {
  it('moves a pasa/falla AC back to pendiente with a reason', () => {
    const result = applyScopeChange(baseDoc(), {
      change: 'reopen',
      date: '2026-11-13',
      acId: 'AC-1',
      reason: 'se encontró un bug',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const ac1 = result.doc.criteria.find((a) => a.id === 'AC-1');
    expect(ac1?.estado).toBe('pendiente');
    expect(ac1?.reason).toBe('se encontró un bug');
  });

  it('rejects reopen without reason', () => {
    const result = applyScopeChange(baseDoc(), {
      change: 'reopen',
      date: '2026-11-13',
      acId: 'AC-1',
    });
    expect(result.ok).toBe(false);
  });

  it('rejects reopen on a pendiente AC', () => {
    const doc = baseDoc({
      criteria: [{ id: 'AC-1', text: 'x', estado: 'pendiente', evidence: [] }],
    });
    const result = applyScopeChange(doc, {
      change: 'reopen',
      date: '2026-11-13',
      acId: 'AC-1',
      reason: 'x',
    });
    expect(result.ok).toBe(false);
  });
});

describe('applyScopeChange — discard (test 1: única vía a descartado)', () => {
  it('discards an AC only with reason AND requestedByUser=true', () => {
    const result = applyScopeChange(baseDoc(), {
      change: 'discard',
      date: '2026-11-13',
      acId: 'AC-2',
      reason: 'ya no aplica',
      requestedByUser: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    const ac2 = result.doc.criteria.find((a) => a.id === 'AC-2');
    expect(ac2?.estado).toBe('descartado');
    expect(result.doc.scopeChanges[0]).toEqual({
      date: '2026-11-13',
      change: 'discard',
      acId: 'AC-2',
      reason: 'ya no aplica',
      requestedByUser: true,
    });
  });

  it('rejects discard without reason', () => {
    const result = applyScopeChange(baseDoc(), {
      change: 'discard',
      date: '2026-11-13',
      acId: 'AC-2',
      requestedByUser: true,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects discard without requestedByUser=true (chamba never self-grants it)', () => {
    const result = applyScopeChange(baseDoc(), {
      change: 'discard',
      date: '2026-11-13',
      acId: 'AC-2',
      reason: 'motivo',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected error');
    expect(result.error).toMatch(/requestedByUser/);
  });

  it('rejects discard with requestedByUser explicitly false', () => {
    const result = applyScopeChange(baseDoc(), {
      change: 'discard',
      date: '2026-11-13',
      acId: 'AC-2',
      reason: 'motivo',
      requestedByUser: false,
    });
    expect(result.ok).toBe(false);
  });
});
