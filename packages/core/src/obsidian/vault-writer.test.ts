import { describe, expect, it } from 'vitest';
import type { ClockPort } from '../ports/clock.js';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { slugify, slugifyGitRemote } from './note-template.js';
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

describe('slugifyGitRemote', () => {
  it('normalizes ssh and https remotes to a stable owner-repo key', () => {
    expect(slugifyGitRemote('git@github.com:acme/app.git')).toBe('acme-app');
    expect(slugifyGitRemote('https://github.com/acme/app.git')).toBe('acme-app');
    expect(slugifyGitRemote('https://github.com/acme/app/')).toBe('acme-app');
    expect(slugifyGitRemote('ssh://git@gitlab.com/acme/app.git')).toBe('acme-app');
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

  it('writes into a custom subdir when given (e.g. plans/)', async () => {
    const fs = new MemoryFilesystem({});
    const { notePath } = await new VaultWriter(fs, fixedClock).write({
      vaultPath: '/v',
      title: 'TICKET-9',
      content: 'the plan',
      subdir: 'plans',
    });
    expect(notePath).toBe('/v/plans/2026-06-09-ticket-9.md');
  });

  it('maintains a folder INDEX.md after writing', async () => {
    const fs = new MemoryFilesystem({});
    await new VaultWriter(fs, fixedClock).write({
      vaultPath: '/v',
      title: 'Auth decisions',
      content: '# Auth\n\nWe use magic links.',
    });
    const index = await fs.readFile('/v/proyectos/INDEX.md');
    expect(index).toContain('# proyectos index');
    expect(index).toContain('](2026-06-09-auth-decisions.md)');
    expect(index).toContain('We use magic links.');
  });

  it('groups notes under a per-project subfolder when a remote is given', async () => {
    const fs = new MemoryFilesystem({});
    const { notePath } = await new VaultWriter(fs, fixedClock).write({
      vaultPath: '/v',
      title: 'Auth',
      content: 'body',
      projectRemoteUrl: 'git@github.com:acme/app.git',
    });
    expect(notePath).toBe('/v/proyectos/acme-app/2026-06-09-auth.md');
    expect(await fs.exists('/v/proyectos/acme-app/INDEX.md')).toBe(true);
  });
});
