import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import type { Workspace } from '../workspace/workspace.js';
import { VAULT_OVERVIEW_FILE, VaultInitializer } from './vault-init.js';

const clock = { now: () => new Date('2026-06-09T00:00:00Z'), today: () => '2026-06-09' };

const workspace: Workspace = {
  root: '/proj',
  description: 'A tiny HTTP API.',
  languages: ['TypeScript'],
  framework: 'Express',
  conventions: ['Biome for lint + format'],
  projects: [{ name: 'proj', path: '.', language: 'TypeScript' }],
  ruleSources: [],
  folderMap: ['src'],
};

describe('VaultInitializer', () => {
  it('creates the .obsidian marker and seeds the overview note', async () => {
    const fs = new MemoryFilesystem({});
    const res = await new VaultInitializer(fs, clock).seed({ vaultPath: '/proj', workspace });

    expect(res.createdMarker).toBe(true);
    expect(res.createdOverview).toBe(true);
    expect(await fs.exists('/proj/.obsidian/app.json')).toBe(true);

    const note = await fs.readFile(`/proj/${VAULT_OVERVIEW_FILE}`);
    expect(note).toContain('title: Workspace overview');
    expect(note).toContain('date: 2026-06-09');
    expect(note).toContain('# Workspace'); // body from renderWorkspaceMarkdown
    expect(note).toContain('A tiny HTTP API.'); // workspace content seeded in
    expect(note).toContain('Express');
  });

  it('does not recreate the marker when one already exists', async () => {
    const fs = new MemoryFilesystem({ '/proj/.obsidian/app.json': '{"theme":"dark"}' });
    const res = await new VaultInitializer(fs, clock).seed({ vaultPath: '/proj', workspace });

    expect(res.createdMarker).toBe(false);
    expect(await fs.readFile('/proj/.obsidian/app.json')).toBe('{"theme":"dark"}');
  });

  it('does not overwrite an existing overview note', async () => {
    const fs = new MemoryFilesystem({ [`/proj/${VAULT_OVERVIEW_FILE}`]: '# mine\n' });
    const res = await new VaultInitializer(fs, clock).seed({ vaultPath: '/proj', workspace });

    expect(res.createdOverview).toBe(false);
    expect(await fs.readFile(`/proj/${VAULT_OVERVIEW_FILE}`)).toBe('# mine\n');
  });
});
