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
