import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import {
  ensureVaultGitignored,
  findGitRoot,
  VAULT_ARTIFACTS,
  vaultGitignoreMissing,
} from './vault-safety.js';

describe('findGitRoot', () => {
  it('walks up to the git work-tree root', async () => {
    const fs = new MemoryFilesystem({
      '/home/proj/.git/HEAD': 'ref: refs/heads/main\n',
      '/home/proj/src/deep/file.ts': 'x',
    });
    expect(await findGitRoot(fs, '/home/proj/src/deep')).toBe('/home/proj');
    expect(await findGitRoot(fs, '/home/proj')).toBe('/home/proj');
  });

  it('detects a linked worktree (.git is a file)', async () => {
    const fs = new MemoryFilesystem({ '/home/wt/.git': 'gitdir: /main/.git/worktrees/wt\n' });
    expect(await findGitRoot(fs, '/home/wt/sub')).toBe('/home/wt');
  });

  it('returns null outside any repo', async () => {
    const fs = new MemoryFilesystem({ '/home/.chamba/vault/Workspace overview.md': '# v' });
    expect(await findGitRoot(fs, '/home/.chamba/vault')).toBeNull();
  });
});

describe('ensureVaultGitignored', () => {
  it('appends the missing vault patterns and is idempotent', async () => {
    const fs = new MemoryFilesystem({ '/repo/.gitignore': 'node_modules\n' });

    const added = await ensureVaultGitignored(fs, '/repo');
    expect(added).toEqual(VAULT_ARTIFACTS);
    const written = await fs.readFile('/repo/.gitignore');
    expect(written).toContain('node_modules');
    expect(written).toContain('.obsidian/');
    expect(written).toContain('.chamba/memory/');

    // second run adds nothing
    expect(await ensureVaultGitignored(fs, '/repo')).toEqual([]);
  });

  it('creates .gitignore when none exists and skips already-present patterns', async () => {
    const fs = new MemoryFilesystem({ '/repo/.gitignore': '.obsidian/\nplans/\n' });
    const added = await ensureVaultGitignored(fs, '/repo');
    expect(added).not.toContain('.obsidian/');
    expect(added).not.toContain('plans/');
    expect(added).toContain('proyectos/');
  });

  it('treats anchored patterns as present (/proyectos/ ≡ proyectos/)', async () => {
    const fs = new MemoryFilesystem({
      '/repo/.gitignore':
        '/.obsidian/\n/Workspace overview.md\n/proyectos/\n/plans/\n/.chamba/memory/\n',
    });
    expect(await vaultGitignoreMissing(fs, '/repo')).toEqual([]);
    expect(await ensureVaultGitignored(fs, '/repo')).toEqual([]);
  });
});
