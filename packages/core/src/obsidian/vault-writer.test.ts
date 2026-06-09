import { describe, expect, it } from 'vitest';
import type { ClockPort } from '../ports/clock.js';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { slugify } from './note-template.js';
import { VaultWriter } from './vault-writer.js';

const fixedClock: ClockPort = {
  now: () => new Date('2026-06-09T00:00:00Z'),
  today: () => '2026-06-09',
};

describe('slugify', () => {
  it('normalizes accents and spaces', () => {
    expect(slugify('Hólá Múndo!')).toBe('hola-mundo');
    expect(slugify('  ')).toBe('note');
  });
});

describe('VaultWriter', () => {
  it('writes a note with valid YAML frontmatter at the dated path', async () => {
    const fs = new MemoryFilesystem({});
    const writer = new VaultWriter(fs, fixedClock);

    const { notePath } = await writer.write({
      vaultPath: '/v',
      title: 'Auth decisions',
      content: 'We use magic links.',
    });

    expect(notePath).toBe('/v/proyectos/2026-06-09-auth-decisions.md');

    const note = await fs.readFile(notePath);
    expect(note.startsWith('---\n')).toBe(true);
    expect(note).toContain('title: "Auth decisions"');
    expect(note).toContain('date: 2026-06-09');
    expect(note).toContain('tags: [chamba, project]');
    expect(note).toContain('source: chamba');
    expect(note).toContain('# Auth decisions');
    expect(note).toContain('We use magic links.');
  });

  it('uses projectSlug for the filename when given', async () => {
    const fs = new MemoryFilesystem({});
    const { notePath } = await new VaultWriter(fs, fixedClock).write({
      vaultPath: '/v',
      title: 'Anything',
      content: 'body',
      projectSlug: 'magic-links',
    });
    expect(notePath).toBe('/v/proyectos/2026-06-09-magic-links.md');
  });
});
