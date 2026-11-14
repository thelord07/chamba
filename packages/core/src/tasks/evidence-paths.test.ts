import { describe, expect, it } from 'vitest';
import { isEvidenceImagePath, isTaskEvidencePath } from './evidence-paths.js';

describe('isTaskEvidencePath', () => {
  it('matches the evidence dir itself and anything nested under it', () => {
    expect(isTaskEvidencePath('tareas/chamba-022/evidencia')).toBe(true);
    expect(isTaskEvidencePath('tareas/chamba-022/evidencia/run-20261113-01/tests-unit.md')).toBe(
      true,
    );
  });

  it('does NOT match the task note itself, or an unrelated top-level "evidencia" dir', () => {
    expect(isTaskEvidencePath('tareas/chamba-022.md')).toBe(false);
    expect(isTaskEvidencePath('evidencia/foo.md')).toBe(false);
  });

  it('does not match a sibling that merely starts with "evidencia"', () => {
    expect(isTaskEvidencePath('tareas/chamba-022/evidenciario.md')).toBe(false);
  });

  it('N6: is case-insensitive — a case-insensitive filesystem may hand back different casing', () => {
    expect(isTaskEvidencePath('Tareas/CHAMBA-022/Evidencia/run-1/tests-unit.md')).toBe(true);
    expect(isTaskEvidencePath('TAREAS/chamba-022/EVIDENCIA')).toBe(true);
  });
});

describe('isEvidenceImagePath (O1 — owner decision)', () => {
  it('matches image extensions (png/jpg/jpeg/gif/webp/svg, case-insensitive) under evidencia/', () => {
    for (const ext of ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'PNG', 'JPG']) {
      expect(isEvidenceImagePath(`tareas/chamba-022/evidencia/run-1/captura.${ext}`)).toBe(true);
    }
  });

  it('does NOT match report.md / tests-*.md — text evidence always syncs unconditionally', () => {
    expect(isEvidenceImagePath('tareas/chamba-022/evidencia/run-1/qa/report.md')).toBe(false);
    expect(isEvidenceImagePath('tareas/chamba-022/evidencia/run-1/tests-unit.md')).toBe(false);
  });

  it('does NOT match an image outside the evidence subtree (regular vault images sync as always)', () => {
    expect(isEvidenceImagePath('proyectos/diagrama.png')).toBe(false);
    expect(isEvidenceImagePath('tareas/chamba-022.md')).toBe(false);
  });

  it('does not match a non-image binary under evidencia/ (e.g. .pdf)', () => {
    expect(isEvidenceImagePath('tareas/chamba-022/evidencia/run-1/qa/report.pdf')).toBe(false);
  });
});
