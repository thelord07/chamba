import { describe, expect, it } from 'vitest';
import {
  describeFromBody,
  parseIndexNote,
  renderIndexNote,
  upsertIndexEntry,
} from './vault-index.js';

describe('vault-index', () => {
  it('round-trips entries through render/parse', () => {
    const entries = [
      {
        title: 'Auth decisions',
        path: '2026-06-09-auth.md',
        description: 'magic links via resend',
      },
      { title: 'Health check', path: '2026-06-10-health.md', description: 'add /healthz' },
    ];
    const parsed = parseIndexNote(renderIndexNote('proyectos', entries));
    expect(parsed).toHaveLength(2);
    expect(parsed).toEqual(expect.arrayContaining(entries));
  });

  it('upserts by path — replaces the same path, keeps the rest', () => {
    let md = renderIndexNote('plans', [{ title: 'A', path: 'a.md', description: 'first' }]);
    md = upsertIndexEntry(md, 'plans', { title: 'B', path: 'b.md', description: 'second' });
    md = upsertIndexEntry(md, 'plans', { title: 'A2', path: 'a.md', description: 'updated' });

    const parsed = parseIndexNote(md);
    expect(parsed).toHaveLength(2);
    const a = parsed.find((e) => e.path === 'a.md');
    expect(a?.title).toBe('A2');
    expect(a?.description).toBe('updated');
  });

  it('creates an index from null', () => {
    const md = upsertIndexEntry(null, 'proyectos', { title: 'X', path: 'x.md', description: 'y' });
    expect(md).toContain('# proyectos index');
    expect(parseIndexNote(md)).toHaveLength(1);
  });

  it('describeFromBody skips headings/quotes and takes the first real line', () => {
    expect(describeFromBody('# Title\n\nWe use magic links.\n')).toBe('We use magic links.');
    expect(describeFromBody('## Goal\n> quote\nreal line')).toBe('real line');
    expect(describeFromBody('# only a heading')).toBe('');
  });

  it('clamps long descriptions to keep the index cheap', () => {
    const md = upsertIndexEntry(null, 'p', {
      title: 't',
      path: 'p.md',
      description: 'x'.repeat(300),
    });
    expect(parseIndexNote(md)[0].description.length).toBeLessThanOrEqual(140);
  });

  it('sanitizes titles containing brackets so parsing stays robust', () => {
    const parsed = parseIndexNote(
      renderIndexNote('p', [{ title: 'A [beta] (wip)', path: 'a.md', description: 'd' }]),
    );
    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe('a.md');
  });
});
