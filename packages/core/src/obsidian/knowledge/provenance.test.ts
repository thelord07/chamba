import { describe, expect, it } from 'vitest';
import { applyProvenancePatch, buildProvenance } from './provenance.js';

describe('buildProvenance', () => {
  it('builds agent and written_at from tool/version/now', () => {
    const p = buildProvenance({
      tool: 'remember',
      version: '1.14.0',
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(p.agent).toBe('chamba/remember@1.14.0');
    expect(p.written_at).toBe('2026-01-01T00:00:00.000Z');
    expect(p.author).toBeUndefined();
  });

  it('omits author when empty/whitespace', () => {
    const p = buildProvenance({ author: '   ', tool: 'x', version: '1', now: new Date() });
    expect(p.author).toBeUndefined();
  });

  it('never includes an email: strips everything from " <"', () => {
    const p = buildProvenance({
      author: 'Joys <j@x.com>',
      tool: 'x',
      version: '1',
      now: new Date(),
    });
    expect(p.author).toBe('Joys');
    expect(JSON.stringify(p)).not.toContain('@x.com');
  });
});

describe('applyProvenancePatch', () => {
  const prov = {
    author: 'Joys',
    agent: 'chamba/remember@1.0.0',
    written_at: '2026-01-01T00:00:00.000Z',
  };

  it('chamba-owned target: always overwrites, estado defaults to propuesto', () => {
    const patch = applyProvenancePatch(undefined, prov, { isChamba: true });
    expect(patch).toEqual({
      author: 'Joys',
      agent: 'chamba/remember@1.0.0',
      written_at: '2026-01-01T00:00:00.000Z',
      estado: 'propuesto',
    });
  });

  it('chamba-owned target: flag is included only when passed', () => {
    const patch = applyProvenancePatch(undefined, prov, { isChamba: true, flag: 'revisar' });
    expect(patch.flag).toBe('revisar');
  });

  it('human-owned target: add-only — existing author is preserved', () => {
    const patch = applyProvenancePatch({ author: 'Human Author' }, prov, {
      isChamba: false,
      estado: 'propuesto',
    });
    expect(patch.author).toBeUndefined();
    expect(patch.agent).toBe('chamba/remember@1.0.0');
    expect(patch.written_at).toBe('2026-01-01T00:00:00.000Z');
    expect(patch.estado).toBe('propuesto');
  });

  it('human-owned target: existing estado/flag/agent/written_at are never overwritten', () => {
    const patch = applyProvenancePatch(
      { agent: 'x', written_at: 'y', estado: 'canonico', flag: 'z' },
      prov,
      { isChamba: false, estado: 'propuesto', flag: 'revisar' },
    );
    // author was absent from `existing`, so it's added (add-only); every other
    // key WAS present and must survive untouched.
    expect(patch).toEqual({ author: 'Joys' });
  });

  it('human-owned target with nothing existing: fills every key', () => {
    const patch = applyProvenancePatch(undefined, prov, {
      isChamba: false,
      estado: 'propuesto',
      flag: 'revisar',
    });
    expect(patch).toEqual({
      author: 'Joys',
      agent: 'chamba/remember@1.0.0',
      written_at: '2026-01-01T00:00:00.000Z',
      estado: 'propuesto',
      flag: 'revisar',
    });
  });
});
