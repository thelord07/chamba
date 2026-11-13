import { describe, expect, it } from 'vitest';
import { assignAcIds } from './criteria.js';

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
