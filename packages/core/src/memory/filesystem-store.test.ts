import { describe, expect, it } from 'vitest';
import type { ClockPort } from '../ports/clock.js';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { FilesystemMemoryStore } from './filesystem-store.js';

function clockAt(iso: string): ClockPort {
  return { now: () => new Date(iso), today: () => iso.slice(0, 10) };
}

describe('FilesystemMemoryStore', () => {
  it('writes a markdown file with frontmatter under .chamba/memory', async () => {
    const fs = new MemoryFilesystem({});
    const store = new FilesystemMemoryStore(fs, clockAt('2026-06-09T10:00:00Z'), '/proj');

    const memory = await store.remember({
      key: 'auth-decisions',
      content: 'We use magic links via Resend.',
      tags: ['auth'],
    });

    expect(memory.path).toBe('/proj/.chamba/memory/auth-decisions.md');
    const file = await fs.readFile(memory.path);
    expect(file.startsWith('---\n')).toBe(true);
    expect(file).toContain('key: auth-decisions');
    expect(file).toContain('tags: [auth]');
    expect(file).toContain('createdAt: 2026-06-09T10:00:00.000Z');
    expect(file).toContain('We use magic links via Resend.');
  });

  it('appends a timestamped section when remembering an existing key', async () => {
    const fs = new MemoryFilesystem({});
    const store = new FilesystemMemoryStore(fs, clockAt('2026-06-09T10:00:00Z'), '/proj');
    await store.remember({ key: 'k', content: 'first note' });

    const store2 = new FilesystemMemoryStore(fs, clockAt('2026-06-10T11:00:00Z'), '/proj');
    const updated = await store2.remember({ key: 'k', content: 'second note', tags: ['x'] });

    const file = await fs.readFile(updated.path);
    expect(file).toContain('first note');
    expect(file).toContain('second note');
    expect(file).toContain('## Update 2026-06-10T11:00:00.000Z');
    expect(file).toContain('createdAt: 2026-06-09T10:00:00.000Z');
    expect(file).toContain('updatedAt: 2026-06-10T11:00:00.000Z');
    expect(file).toContain('tags: [x]');
  });

  it('recalls by case-insensitive substring over key, tags and content', async () => {
    const fs = new MemoryFilesystem({});
    const store = new FilesystemMemoryStore(fs, clockAt('2026-06-09T10:00:00Z'), '/proj');
    await store.remember({ key: 'auth-decisions', content: 'magic links via Resend' });
    await store.remember({ key: 'deploy', content: 'deploys are manual' });

    const matches = await store.recall('AUTH');
    expect(matches.map((m) => m.key)).toEqual(['auth-decisions']);

    const byContent = await store.recall('resend');
    expect(byContent.map((m) => m.key)).toEqual(['auth-decisions']);
  });

  it('returns an empty array when nothing matches', async () => {
    const fs = new MemoryFilesystem({});
    const store = new FilesystemMemoryStore(fs, clockAt('2026-06-09T10:00:00Z'), '/proj');
    await store.remember({ key: 'k', content: 'hello' });
    expect(await store.recall('nothing-here')).toEqual([]);
  });
});

describe('FilesystemMemoryStore — CHAMBA-021 S11 provenance', () => {
  it('a new memory gets author/agent/written_at and estado: propuesto', async () => {
    const fs = new MemoryFilesystem({});
    const store = new FilesystemMemoryStore(fs, clockAt('2026-06-09T10:00:00Z'), '/proj');
    const provenance = {
      author: 'Joys',
      agent: 'chamba/remember@1.0.0',
      written_at: '2026-06-09T10:00:00.000Z',
    };
    const memory = await store.remember({ key: 'k', content: 'hello', provenance });
    expect(memory.author).toBe('Joys');
    expect(memory.agent).toBe('chamba/remember@1.0.0');
    expect(memory.estado).toBe('propuesto');

    const file = await fs.readFile(memory.path);
    expect(file).toContain('author: Joys');
    expect(file).toContain('estado: propuesto');
  });

  it('re-remembering an existing chamba memory updates written_at/agent/author and keeps estado propuesto', async () => {
    const fs = new MemoryFilesystem({});
    const provenance = {
      author: 'Joys',
      agent: 'chamba/remember@1.0.0',
      written_at: '2026-06-09T10:00:00.000Z',
    };
    const store = new FilesystemMemoryStore(fs, clockAt('2026-06-09T10:00:00Z'), '/proj');
    await store.remember({ key: 'k', content: 'first', provenance });

    const store2 = new FilesystemMemoryStore(fs, clockAt('2026-06-10T11:00:00Z'), '/proj');
    const updated = await store2.remember({
      key: 'k',
      content: 'second',
      provenance: { ...provenance, written_at: '2026-06-10T11:00:00.000Z' },
    });
    expect(updated.written_at).toBe('2026-06-10T11:00:00.000Z');
    expect(updated.estado).toBe('propuesto');
  });

  it('a human-authored memory file at the same key keeps its author add-only', async () => {
    const fs = new MemoryFilesystem({
      '/proj/.chamba/memory/k.md': [
        '---',
        'key: k',
        'tags: []',
        'createdAt: 2026-01-01T00:00:00.000Z',
        'updatedAt: 2026-01-01T00:00:00.000Z',
        'author: Human Author',
        '---',
        '',
        'Written by hand.',
        '',
      ].join('\n'),
    });
    const store = new FilesystemMemoryStore(fs, clockAt('2026-06-09T10:00:00Z'), '/proj');
    const memory = await store.remember({
      key: 'k',
      content: 'agent update',
      provenance: {
        author: 'Joys',
        agent: 'chamba/remember@1.0.0',
        written_at: '2026-06-09T10:00:00.000Z',
      },
    });
    expect(memory.author).toBe('Human Author');
    expect(memory.agent).toBe('chamba/remember@1.0.0');
    expect(memory.content).toContain('Written by hand.');
  });
});
