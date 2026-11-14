import { describe, expect, it } from 'vitest';
import { readBlock, upsertBlock } from './task-blocks.js';

describe('readBlock / upsertBlock', () => {
  it('reads the body between markers, trimming one leading/trailing newline', () => {
    const md = [
      '# Título',
      '',
      '<!-- chamba:task:progress:start -->',
      '- 2026-11-13: hito 1',
      '<!-- chamba:task:progress:end -->',
      '',
    ].join('\n');
    expect(readBlock(md, 'progress')).toBe('- 2026-11-13: hito 1');
  });

  it('returns undefined when the block is absent', () => {
    expect(readBlock('# nada acá', 'progress')).toBeUndefined();
  });

  it('upsertBlock replaces only the block body, leaving everything else byte-for-byte', () => {
    const md = [
      '# Título',
      '',
      'Texto humano antes.',
      '',
      '<!-- chamba:task:next_step:start -->',
      'viejo',
      '<!-- chamba:task:next_step:end -->',
      '',
      'Texto humano después.',
    ].join('\n');

    const next = upsertBlock(md, 'next_step', 'nuevo');
    expect(readBlock(next, 'next_step')).toBe('nuevo');
    expect(next).toContain('Texto humano antes.');
    expect(next).toContain('Texto humano después.');
  });

  it('appends a well-formed block when absent (NN5: never leaves a document unwritable)', () => {
    const md = '# Título\n\nSin secciones todavía.';
    const next = upsertBlock(md, 'scope_changes', '- 2026-11-13 · add · AC-2 · nuevo alcance');
    expect(readBlock(next, 'scope_changes')).toBe('- 2026-11-13 · add · AC-2 · nuevo alcance');
    expect(next).toContain('Sin secciones todavía.');
  });

  it('human text written OUTSIDE a block survives a rewrite of that block', () => {
    const md = [
      '<!-- chamba:task:close:start -->',
      'viejo cierre',
      '<!-- chamba:task:close:end -->',
      '',
      '## Notas manuales',
      'esto lo escribió un humano y no debe desaparecer',
    ].join('\n');
    const next = upsertBlock(md, 'close', 'nuevo cierre');
    expect(next).toContain('esto lo escribió un humano y no debe desaparecer');
    expect(readBlock(next, 'close')).toBe('nuevo cierre');
  });
});
