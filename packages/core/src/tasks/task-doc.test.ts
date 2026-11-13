import { describe, expect, it } from 'vitest';
import {
  parseTaskDoc,
  renderTaskDoc,
  type TaskDoc,
  taskEvidenceRelDir,
  taskNoteRelPath,
} from './task-doc.js';

describe('taskNoteRelPath / taskEvidenceRelDir', () => {
  it('derives the note path from normalizeWorkItemId', () => {
    expect(taskNoteRelPath('CHAMBA-022')).toBe('tareas/chamba-022.md');
  });

  it('derives the evidence dir from workItem + runId', () => {
    expect(taskEvidenceRelDir('CHAMBA-022', 'run-20261113-01')).toBe(
      'tareas/chamba-022/evidencia/run-20261113-01',
    );
  });
});

function fullDoc(): TaskDoc {
  return {
    workItem: 'CHAMBA-022',
    title: 'tarea viva y evidencia',
    route: 'risky',
    request: 'implementar el módulo de tareas',
    criteria: [
      {
        id: 'AC-1',
        text: 'El documento se crea con AC numerados',
        estado: 'pasa',
        evidence: ['tareas/chamba-022/evidencia/run-20261113-01/tests-unit.md'],
      },
      {
        id: 'AC-2',
        text: 'La compuerta bloquea sin evidencia',
        estado: 'pendiente',
        evidence: [],
        reason: 'en curso',
      },
      {
        id: 'AC-3',
        text: 'AC descartado de ejemplo',
        estado: 'descartado',
        evidence: [],
        reason: 'ya no aplica',
      },
    ],
    checklist: [
      { text: 'escribir tests', done: true },
      { text: 'actualizar docs', done: false },
    ],
    progressLog: ['- 2026-11-13: módulo tasks/ creado'],
    nextStep: 'correr verify',
    scopeChanges: [
      {
        date: '2026-11-13',
        change: 'discard',
        acId: 'AC-3',
        reason: 'ya no aplica',
        requestedByUser: true,
      },
    ],
    verifyRuns: [
      {
        runId: 'run-20261113-01',
        date: '2026-11-13',
        head: 'abc1234',
        dirty: false,
        level: 'executed',
        worktreePath: '/ws/CHAMBA-022/chamba',
        commands: [
          {
            name: 'unit',
            exitCode: 0,
            timedOut: false,
            truncated: false,
            durationMs: 1234,
            evidencePath: 'tareas/chamba-022/evidencia/run-20261113-01/tests-unit.md',
          },
        ],
      },
    ],
    evidence: [{ path: 'tareas/chamba-022/evidencia/run-20261113-01/report.md', kind: 'qa' }],
    estadoTarea: 'en_progreso',
    worktreePath: '/ws/CHAMBA-022/chamba',
    repos: ['chamba', 'chamba-console'],
  };
}

describe('renderTaskDoc / parseTaskDoc — round trip', () => {
  it('round-trips the main fields for a risky-route document', () => {
    const doc = fullDoc();
    const md = renderTaskDoc(doc, { date: '2026-11-13' });
    const parsed = parseTaskDoc(md);
    expect('error' in parsed).toBe(false);
    if ('error' in parsed) throw new Error(parsed.error);

    expect(parsed.doc.workItem).toBe('CHAMBA-022');
    expect(parsed.doc.route).toBe('risky');
    expect(parsed.doc.estadoTarea).toBe('en_progreso');
    expect(parsed.doc.criteria).toHaveLength(3);
    expect(parsed.doc.criteria[0]).toMatchObject({ id: 'AC-1', estado: 'pasa' });
    expect(parsed.doc.criteria[0]?.evidence).toEqual([
      'tareas/chamba-022/evidencia/run-20261113-01/tests-unit.md',
    ]);
    expect(parsed.doc.criteria[1]).toMatchObject({
      id: 'AC-2',
      estado: 'pendiente',
      reason: 'en curso',
    });
    expect(parsed.doc.criteria[2]).toMatchObject({ id: 'AC-3', estado: 'descartado' });
    expect(parsed.doc.scopeChanges).toHaveLength(1);
    expect(parsed.doc.scopeChanges[0]).toMatchObject({
      change: 'discard',
      acId: 'AC-3',
      requestedByUser: true,
    });
    expect(parsed.doc.verifyRuns).toHaveLength(1);
    expect(parsed.doc.verifyRuns[0]?.head).toBe('abc1234');
    expect(parsed.doc.verifyRuns[0]?.commands[0]).toMatchObject({ name: 'unit', exitCode: 0 });
    expect(parsed.doc.verifyRuns[0]?.worktreePath).toBe('/ws/CHAMBA-022/chamba');
    expect(parsed.doc.checklist).toEqual([
      { text: 'escribir tests', done: true },
      { text: 'actualizar docs', done: false },
    ]);
    expect(parsed.doc.worktreePath).toBe('/ws/CHAMBA-022/chamba');
    expect(parsed.doc.repos).toEqual(['chamba', 'chamba-console']);
  });

  it('text written outside the delimited blocks survives a re-render', () => {
    const doc = fullDoc();
    const md = renderTaskDoc(doc, { date: '2026-11-13' });
    const withHumanNote = `${md}\n\n## Notas del equipo\nEsto lo escribió un humano.\n`;
    const reparsed = parseTaskDoc(withHumanNote);
    expect('error' in reparsed).toBe(false);
    expect(withHumanNote).toContain('Esto lo escribió un humano.');
  });

  it('small route omits Checklist/Progreso/Siguiente paso', () => {
    const doc: TaskDoc = { ...fullDoc(), route: 'small' };
    const md = renderTaskDoc(doc, { date: '2026-11-13' });
    expect(md).not.toContain('## Checklist');
    expect(md).not.toContain('## Progreso');
  });

  it('fails clearly when work_item is missing', () => {
    const result = parseTaskDoc('# sin frontmatter\n');
    expect('error' in result).toBe(true);
  });
});
