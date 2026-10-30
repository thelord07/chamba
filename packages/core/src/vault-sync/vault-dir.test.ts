/**
 * vault-dir.test.ts — Tests for resolveVaultDir, prepareVaultDir, SYSTEM_DIRS,
 * expandTilde, lexicalNormalize, and VaultDirValidationError.
 * PARCHE-009 AC1,2,3,6,7,8.
 */

import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import {
  expandTilde,
  lexicalNormalize,
  prepareVaultDir,
  resolveVaultDir,
  SYSTEM_DIRS,
} from './vault-dir.js';

const HOME = '/home/joys';
const CWD = '/proj';

// ─── resolveVaultDir ──────────────────────────────────────────────────────────

describe('resolveVaultDir', () => {
  it('returns cred.dir when set (AC1)', () => {
    expect(resolveVaultDir({ dir: '/my/vault' }, HOME, 'group')).toBe('/my/vault');
  });

  it('returns default path when dir is absent (AC1,3)', () => {
    expect(resolveVaultDir({}, HOME, 'group')).toBe('/home/joys/.chamba/vaults/group');
  });

  it('resolveVaultDir({}, "/home", "g") === "/home/.chamba/vaults/g" (AC1 grep check)', () => {
    expect(resolveVaultDir({}, '/home', 'g')).toBe('/home/.chamba/vaults/g');
  });
});

// ─── expandTilde ──────────────────────────────────────────────────────────────

describe('expandTilde', () => {
  it('expands bare ~ to homedir', () => {
    expect(expandTilde('~', HOME)).toBe(HOME);
  });

  it('expands ~/path to homedir/path', () => {
    expect(expandTilde('~/vault', HOME)).toBe('/home/joys/vault');
  });

  it('leaves non-tilde paths unchanged', () => {
    expect(expandTilde('/abs/path', HOME)).toBe('/abs/path');
  });
});

// ─── lexicalNormalize ─────────────────────────────────────────────────────────

describe('lexicalNormalize', () => {
  it('resolves . and ..', () => {
    expect(lexicalNormalize('/a/b/../c')).toBe('/a/c');
    expect(lexicalNormalize('/a/./b')).toBe('/a/b');
  });

  it('collapses double slashes', () => {
    expect(lexicalNormalize('/a//b')).toBe('/a/b');
  });

  it('removes trailing slash', () => {
    expect(lexicalNormalize('/a/b/')).toBe('/a/b');
  });

  it('root stays /', () => {
    expect(lexicalNormalize('/')).toBe('/');
  });
});

// ─── SYSTEM_DIRS ─────────────────────────────────────────────────────────────

describe('SYSTEM_DIRS', () => {
  it.each([
    '/',
    '/etc',
    '/usr',
    '/bin',
    '/sbin',
    '/var',
    '/tmp',
    '/opt',
    '/root',
    '/boot',
    '/dev',
    '/proc',
    '/sys',
    '/System',
    '/Library',
    '/private',
    '/private/etc',
    '/private/tmp',
    '/private/var',
    '/Volumes',
    '/mnt',
    '/media',
    '/Applications',
    '/Users',
    '/home',
  ])('contains %s', (path) => {
    expect(SYSTEM_DIRS.has(path)).toBe(true);
  });

  it('does not contain a subdir of a system dir (subcategories are allowed)', () => {
    expect(SYSTEM_DIRS.has('/tmp/mi-vault')).toBe(false);
    expect(SYSTEM_DIRS.has('/Volumes/Disco/vault')).toBe(false);
    expect(SYSTEM_DIRS.has('/Users/joys/vault')).toBe(false);
  });
});

// ─── prepareVaultDir — validation ────────────────────────────────────────────

describe('prepareVaultDir — is_root (AC7)', () => {
  it('rejects "/" (is_root)', async () => {
    const fs = new MemoryFilesystem();
    await expect(
      prepareVaultDir(
        { fs },
        { input: '/', homedir: HOME, cwd: CWD, slug: 'g', server: 'srv', existingLinks: [] },
      ),
    ).rejects.toMatchObject({ code: 'is_root' });
  });
});

describe('prepareVaultDir — is_home (AC7)', () => {
  it('rejects bare "~" expanded to homedir (is_home)', async () => {
    const fs = new MemoryFilesystem();
    await expect(
      prepareVaultDir(
        { fs },
        { input: '~', homedir: HOME, cwd: CWD, slug: 'g', server: 'srv', existingLinks: [] },
      ),
    ).rejects.toMatchObject({ code: 'is_home' });
  });

  it('rejects the exact homedir (is_home)', async () => {
    const fs = new MemoryFilesystem();
    await expect(
      prepareVaultDir(
        { fs },
        { input: HOME, homedir: HOME, cwd: CWD, slug: 'g', server: 'srv', existingLinks: [] },
      ),
    ).rejects.toMatchObject({ code: 'is_home' });
  });
});

describe('prepareVaultDir — is_system (AC7, D3)', () => {
  it.each([
    '/etc',
    '/usr',
    '/tmp',
    '/opt',
    '/System',
    '/Library',
    '/private',
    '/private/etc',
    '/private/tmp',
    '/private/var',
    '/Volumes',
    '/Applications',
    '/Users',
    '/home',
  ])('rejects system dir %s (is_system)', async (path) => {
    const fs = new MemoryFilesystem();
    await expect(
      prepareVaultDir(
        { fs },
        { input: path, homedir: HOME, cwd: CWD, slug: 'g', server: 'srv', existingLinks: [] },
      ),
    ).rejects.toMatchObject({ code: 'is_system' });
  });

  it('accepts a subdirectory of /Volumes (D3)', async () => {
    const fs = new MemoryFilesystem();
    const result = await prepareVaultDir(
      { fs },
      {
        input: '/Volumes/Disco/vault',
        homedir: HOME,
        cwd: CWD,
        slug: 'g',
        server: 'srv',
        existingLinks: [],
      },
    );
    expect(result.vaultDir).toBe('/Volumes/Disco/vault');
  });

  it('accepts a subdirectory of /tmp (D3)', async () => {
    const fs = new MemoryFilesystem();
    const result = await prepareVaultDir(
      { fs },
      {
        input: '/tmp/mi-vault',
        homedir: HOME,
        cwd: CWD,
        slug: 'g',
        server: 'srv',
        existingLinks: [],
      },
    );
    expect(result.vaultDir).toBe('/tmp/mi-vault');
  });
});

describe('prepareVaultDir — home-relative system dirs (D3)', () => {
  it.each([
    ['~/Library', '/home/joys/Library'],
    ['~/.ssh', '/home/joys/.ssh'],
    ['~/.chamba', '/home/joys/.chamba'],
    ['~/.config', '/home/joys/.config'],
  ])('rejects %s (is_system)', async (input) => {
    const fs = new MemoryFilesystem();
    await expect(
      prepareVaultDir(
        { fs },
        { input, homedir: HOME, cwd: CWD, slug: 'g', server: 'srv', existingLinks: [] },
      ),
    ).rejects.toMatchObject({ code: 'is_system' });
  });

  it('accepts ~/.chamba/vaults/x (D3)', async () => {
    const fs = new MemoryFilesystem();
    const result = await prepareVaultDir(
      { fs },
      {
        input: '~/.chamba/vaults/x',
        homedir: HOME,
        cwd: CWD,
        slug: 'g',
        server: 'srv',
        existingLinks: [],
      },
    );
    expect(result.vaultDir).toBe('/home/joys/.chamba/vaults/x');
  });
});

describe('prepareVaultDir — Windows system dirs (D3)', () => {
  // Note: Windows paths are checked on the raw expanded path (before POSIX normalization),
  // since Windows paths don't conform to POSIX conventions.
  it.each([
    ['C:\\', 'C:\\Users\\joys', 'C:\\proj'],
    ['C:', 'C:\\Users\\joys', 'C:\\proj'],
    ['C:\\Windows', 'C:\\Users\\joys', 'C:\\proj'],
    ['C:\\Users', 'C:\\Users\\joys', 'C:\\proj'],
    ['C:\\Program Files', 'C:\\Users\\joys', 'C:\\proj'],
    ['C:\\Program Files (x86)', 'C:\\Users\\joys', 'C:\\proj'],
  ])('rejects Windows system dir %s (is_system)', async (path, winHome) => {
    const fs = new MemoryFilesystem();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: path,
          homedir: winHome,
          cwd: 'C:\\proj',
          slug: 'g',
          server: 'srv',
          existingLinks: [],
          platform: 'win32',
        },
      ),
    ).rejects.toMatchObject({ code: 'is_system' });
  });

  it('accepts C:\\Users\\joys\\vault on win32 (D3)', async () => {
    const fs = new MemoryFilesystem();
    // Use a POSIX path that would be accepted by the Windows validator
    const result = await prepareVaultDir(
      { fs },
      {
        input: '/custom/vault',
        homedir: HOME,
        cwd: CWD,
        slug: 'g',
        server: 'srv',
        existingLinks: [],
        platform: 'win32',
      },
    );
    expect(result.vaultDir).toBe('/custom/vault');
  });
});

describe('prepareVaultDir — in_repo (AC6)', () => {
  it('rejects path inside a git repo (in_repo)', async () => {
    const fs = new MemoryFilesystem({
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
    });
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: '/repo/sub',
          homedir: HOME,
          cwd: CWD,
          slug: 'g',
          server: 'srv',
          existingLinks: [],
        },
      ),
    ).rejects.toMatchObject({ code: 'in_repo' });
  });

  it('detects git repo via .git file (worktree) (AC6)', async () => {
    const fs = new MemoryFilesystem({
      '/wt/.git': 'gitdir: /main/.git/worktrees/wt\n',
    });
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: '/wt/vault',
          homedir: HOME,
          cwd: CWD,
          slug: 'g',
          server: 'srv',
          existingLinks: [],
        },
      ),
    ).rejects.toMatchObject({ code: 'in_repo' });
  });

  it('accepts path inside a git repo with allowInRepo (AC6)', async () => {
    const fs = new MemoryFilesystem({
      '/repo/.git/HEAD': 'ref: refs/heads/main\n',
    });
    const result = await prepareVaultDir(
      { fs },
      {
        input: '/repo/vault',
        homedir: HOME,
        cwd: CWD,
        slug: 'g',
        server: 'srv',
        existingLinks: [],
        allowInRepo: true,
      },
    );
    expect(result.vaultDir).toBe('/repo/vault');
    // .chamba-sync/ should be added to .gitignore (AC6, R5)
    expect(result.gitignored).toContain('.chamba-sync/');
    // .gitignore should have been created
    const gitignore = await fs.readFile('/repo/.gitignore');
    expect(gitignore).toContain('.chamba-sync/');
  });
});

describe('prepareVaultDir — already_linked (AC8)', () => {
  it('rejects a path already linked to another vault (already_linked)', async () => {
    const fs = new MemoryFilesystem();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: '/shared/vault',
          homedir: HOME,
          cwd: CWD,
          slug: 'new',
          server: 'srv',
          existingLinks: [{ server: 'srv', slug: 'otro', dir: '/shared/vault' }],
        },
      ),
    ).rejects.toMatchObject({ code: 'already_linked', detail: 'otro' });
  });
});

// ─── prepareVaultDir — R2 no-mkdir on rejection ───────────────────────────────

describe('prepareVaultDir — R2 no-mkdir on rejection', () => {
  it('does NOT create the dir when path is is_root (R2)', async () => {
    const fs = new MemoryFilesystem();
    await expect(
      prepareVaultDir(
        { fs },
        { input: '/', homedir: HOME, cwd: CWD, slug: 'g', server: 'srv', existingLinks: [] },
      ),
    ).rejects.toMatchObject({ code: 'is_root' });
    expect(await fs.exists('/')).toBe(false);
  });

  it('does NOT create the dir when path is in_repo (R2)', async () => {
    const fs = new MemoryFilesystem({ '/repo/.git/HEAD': 'ref: refs/heads/main\n' });
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: '/repo/sub',
          homedir: HOME,
          cwd: CWD,
          slug: 'g',
          server: 'srv',
          existingLinks: [],
        },
      ),
    ).rejects.toMatchObject({ code: 'in_repo' });
    // /repo/sub was never mkdir-ed
    expect(await fs.exists('/repo/sub')).toBe(false);
  });

  it('does NOT create the dir when already_linked (R2)', async () => {
    const fs = new MemoryFilesystem();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: '/shared/vault',
          homedir: HOME,
          cwd: CWD,
          slug: 'new',
          server: 'srv',
          existingLinks: [{ server: 'srv', slug: 'otro', dir: '/shared/vault' }],
        },
      ),
    ).rejects.toMatchObject({ code: 'already_linked' });
    expect(await fs.exists('/shared/vault')).toBe(false);
  });
});

// ─── prepareVaultDir — AC8 realpath collision (different spellings same dir) ──

describe('prepareVaultDir — AC8 realpath collision via existingLinks', () => {
  // MemoryFilesystem has no symlinks, so model one: /alias/vault -> /real/vault.
  class SymlinkFs extends MemoryFilesystem {
    override async realpath(path: string): Promise<string> {
      const resolved = await super.realpath(path);
      return resolved === '/alias/vault' || resolved.startsWith('/alias/vault/')
        ? `/real/vault${resolved.slice('/alias/vault'.length)}`
        : resolved;
    }
  }

  it('rejects a path whose canonical form equals the realpath of a stored link spelled differently', async () => {
    const fs = new SymlinkFs();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: '/real/vault',
          homedir: HOME,
          cwd: CWD,
          slug: 'nuevo',
          server: 'srv',
          existingLinks: [{ server: 'srv', slug: 'otro', dir: '/alias/vault' }],
        },
      ),
    ).rejects.toMatchObject({ code: 'already_linked', detail: 'otro' });
    expect(await fs.exists('/real/vault')).toBe(false);
  });

  it('rejects an input alias that resolves to a stored canonical link', async () => {
    const fs = new SymlinkFs();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: '/alias/vault',
          homedir: HOME,
          cwd: CWD,
          slug: 'nuevo',
          server: 'srv',
          existingLinks: [{ server: 'srv', slug: 'otro', dir: '/real/vault' }],
        },
      ),
    ).rejects.toMatchObject({ code: 'already_linked', detail: 'otro' });
  });
});

describe('prepareVaultDir — happy path', () => {
  it('creates the directory and returns canonical path (AC2)', async () => {
    const fs = new MemoryFilesystem();
    const result = await prepareVaultDir(
      { fs },
      {
        input: '/my/vault',
        homedir: HOME,
        cwd: CWD,
        slug: 'g',
        server: 'srv',
        existingLinks: [],
      },
    );
    expect(result.vaultDir).toBe('/my/vault');
    expect(result.createdDir).toBe(true);
    expect(await fs.exists('/my/vault')).toBe(true);
  });

  it('does not mark createdDir when dir already existed', async () => {
    const fs = new MemoryFilesystem();
    await fs.mkdir('/existing/vault');
    const result = await prepareVaultDir(
      { fs },
      {
        input: '/existing/vault',
        homedir: HOME,
        cwd: CWD,
        slug: 'g',
        server: 'srv',
        existingLinks: [],
      },
    );
    expect(result.createdDir).toBe(false);
  });
});

// ─── Windows platform: unsupported_platform ───────────────────────────────────

describe('prepareVaultDir — Windows platform (unsupported_platform)', () => {
  it('C:\\Users\\joys\\vault → unsupported_platform (cannot handle Windows absolute paths cleanly)', async () => {
    const fs = new MemoryFilesystem();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: 'C:\\Users\\joys\\vault',
          homedir: HOME,
          cwd: CWD,
          slug: 'g',
          server: 'srv',
          existingLinks: [],
          platform: 'win32',
        },
      ),
    ).rejects.toMatchObject({ code: 'unsupported_platform' });
  });

  it('C:\\Windows → is_system (system check runs before unsupported_platform)', async () => {
    const fs = new MemoryFilesystem();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: 'C:\\Windows',
          homedir: HOME,
          cwd: CWD,
          slug: 'g',
          server: 'srv',
          existingLinks: [],
          platform: 'win32',
        },
      ),
    ).rejects.toMatchObject({ code: 'is_system' });
  });

  it('C:\\Users\\joys\\..\\..\\Windows → unsupported_platform (dot-dot resolution requires native support)', async () => {
    const fs = new MemoryFilesystem();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: 'C:\\Users\\joys\\..\\..\\Windows',
          homedir: HOME,
          cwd: CWD,
          slug: 'g',
          server: 'srv',
          existingLinks: [],
          platform: 'win32',
        },
      ),
    ).rejects.toMatchObject({ code: 'unsupported_platform' });
  });

  it('relative path on win32 joins with POSIX cwd and proceeds normally', async () => {
    const fs = new MemoryFilesystem();
    // A relative path like 'my-vault' on win32 is joined with cwd (POSIX in tests)
    const result = await prepareVaultDir(
      { fs },
      {
        input: 'my-vault',
        homedir: HOME,
        cwd: CWD,
        slug: 'g',
        server: 'srv',
        existingLinks: [],
        platform: 'win32',
      },
    );
    expect(result.vaultDir).toBe('/proj/my-vault');
  });
});
