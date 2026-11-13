import { describe, expect, it } from 'vitest';
import { assertCriteriaImmutable, assignAcIds, normalizeAcText } from './criteria.js';

describe('assignAcIds', () => {
  it('assigns AC-1…AC-n in order', () => {
    const result = assignAcIds(['primero', 'segundo', 'tercero']);
    expect(result).toEqual([
      { id: 'AC-1', text: 'primero' },
      { id: 'AC-2', text: 'segundo' },
      { id: 'AC-3', text: 'tercero' },
    ]);
  });
});

describe('normalizeAcText', () => {
  it('tolerates CRLF, trimming and whitespace collapsing', () => {
    expect(normalizeAcText('  texto  con\r\n  espacios  ')).toBe('texto con espacios');
  });
});

describe('assertCriteriaImmutable', () => {
  it('passes when texts are identical (even across CRLF/whitespace)', () => {
    const result = assertCriteriaImmutable(
      [{ id: 'AC-1', text: 'Hacer X' }],
      [{ id: 'AC-1', text: '  Hacer   X\r\n' }],
    );
    expect(result).toEqual({ ok: true });
  });

  it('flags an AC whose text changed, naming it', () => {
    const result = assertCriteriaImmutable(
      [
        { id: 'AC-1', text: 'Hacer X' },
        { id: 'AC-2', text: 'Hacer Y' },
      ],
      [
        { id: 'AC-1', text: 'Hacer X editado a mano' },
        { id: 'AC-2', text: 'Hacer Y' },
      ],
    );
    expect(result).toEqual({ ok: false, changed: ['AC-1'] });
  });

  it('does not compare an id only present in `next` (newly added AC)', () => {
    const result = assertCriteriaImmutable(
      [{ id: 'AC-1', text: 'Hacer X' }],
      [
        { id: 'AC-1', text: 'Hacer X' },
        { id: 'AC-2', text: 'Recién agregado' },
      ],
    );
    expect(result).toEqual({ ok: true });
  });
});
