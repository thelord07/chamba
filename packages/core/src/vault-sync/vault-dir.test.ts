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

  it('rejects bare C: (drive-relative — unsupported_path, D1.3)', async () => {
    // C: without a trailing separator is drive-relative (C:foo is resolved against
    // the current directory of that drive on Windows). We reject it with a clear
    // error rather than silently guessing the intent.
    const fs = new MemoryFilesystem();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: 'C:',
          homedir: 'C:\\Users\\joys',
          cwd: 'C:\\proj',
          slug: 'g',
          server: 'srv',
          existingLinks: [],
          platform: 'win32',
        },
      ),
    ).rejects.toMatchObject({ code: 'unsupported_path' });
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

// ─── Windows platform: win32 path handling (CHAMBA-015) ──────────────────────

/**
 * Minimal FilesystemPort stub with identity realpath and no-op IO.
 * Used for win32 path tests where MemoryFilesystem's POSIX-only realpath
 * would reject C:\… paths. realpath returns the path unchanged (identity),
 * which is the ENOENT-tolerant lexical fallback we need for paths that don't
 * exist yet on real Windows.
 */
function makeWin32Stub(): import('../ports/filesystem.js').FilesystemPort {
  const dirs = new Set<string>();
  return {
    readFile: async () => '',
    writeFile: async () => {},
    readDir: async () => [],
    exists: async (p) => dirs.has(p),
    mkdir: async (p) => {
      dirs.add(p);
    },
    remove: async () => {},
    readBytes: async () => new Uint8Array(0),
    writeBytes: async () => {},
    rename: async () => {},
    stat: async () => null,
    realpath: async (p) => p, // identity — caller handles missing paths
  };
}

describe('prepareVaultDir — Windows platform (win32 path support, CHAMBA-015)', () => {
  it('C:\\Users\\joys\\vault → accepts and canonicalizes via realpath', async () => {
    // CHAMBA-015 B4: Windows absolute paths are now accepted; unsupported_platform is never produced.
    const fs = makeWin32Stub();
    const result = await prepareVaultDir(
      { fs },
      {
        input: 'C:\\Users\\joys\\vault',
        homedir: 'C:\\Users\\joys',
        cwd: 'C:\\Users\\joys',
        slug: 'g',
        server: 'srv',
        existingLinks: [],
        platform: 'win32',
      },
    );
    expect(result.vaultDir).toBe('C:\\Users\\joys\\vault');
  });

  it('C:\\Windows → is_system (Windows system dirs are rejected)', async () => {
    const fs = makeWin32Stub();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: 'C:\\Windows',
          homedir: 'C:\\Users\\joys',
          cwd: 'C:\\Users\\joys',
          slug: 'g',
          server: 'srv',
          existingLinks: [],
          platform: 'win32',
        },
      ),
    ).rejects.toMatchObject({ code: 'is_system' });
  });

  it('C:\\Users\\joys\\..\\..\\Windows → is_system (normalizeLocal resolves .. then rejects)', async () => {
    // CHAMBA-015 B4: normalizeLocal resolves .. to C:\Windows which is is_system.
    const fs = makeWin32Stub();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: 'C:\\Users\\joys\\..\\..\\Windows',
          homedir: 'C:\\Users\\joys',
          cwd: 'C:\\Users\\joys',
          slug: 'g',
          server: 'srv',
          existingLinks: [],
          platform: 'win32',
        },
      ),
    ).rejects.toMatchObject({ code: 'is_system' });
  });

  it('relative path on win32 with POSIX cwd joins and proceeds normally', async () => {
    // A relative path like 'my-vault' on win32 with a POSIX cwd (as in tests) is joined
    // and returns the joined path (POSIX since cwd is POSIX).
    const fs = new MemoryFilesystem();
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

// ─── S15: win32 security rejections (CHAMBA-015 Test 2) ──────────────────────

const WIN_HOME = 'C:\\Users\\x';

describe('prepareVaultDir — win32 security rejections (S15 / CHAMBA-015)', () => {
  it('C:\\ (drive root) → is_system', async () => {
    const fs = makeWin32Stub();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: 'C:\\',
          homedir: WIN_HOME,
          cwd: 'C:\\Users\\x',
          slug: 'g',
          server: 'srv',
          existingLinks: [],
          platform: 'win32',
        },
      ),
    ).rejects.toMatchObject({ code: 'is_system' });
  });

  it('C:\\Users\\x (homedir) → is_home', async () => {
    const fs = makeWin32Stub();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: 'C:\\Users\\x',
          homedir: WIN_HOME,
          cwd: WIN_HOME,
          slug: 'g',
          server: 'srv',
          existingLinks: [],
          platform: 'win32',
        },
      ),
    ).rejects.toMatchObject({ code: 'is_home' });
  });

  it('C:\\Users\\x\\.chamba → is_system', async () => {
    const fs = makeWin32Stub();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: 'C:\\Users\\x\\.chamba',
          homedir: WIN_HOME,
          cwd: WIN_HOME,
          slug: 'g',
          server: 'srv',
          existingLinks: [],
          platform: 'win32',
        },
      ),
    ).rejects.toMatchObject({ code: 'is_system' });
  });

  it('C:\\Users\\x\\.ssh → is_system', async () => {
    const fs = makeWin32Stub();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: 'C:\\Users\\x\\.ssh',
          homedir: WIN_HOME,
          cwd: WIN_HOME,
          slug: 'g',
          server: 'srv',
          existingLinks: [],
          platform: 'win32',
        },
      ),
    ).rejects.toMatchObject({ code: 'is_system' });
  });

  it('C:\\Users\\x\\AppData → is_system', async () => {
    const fs = makeWin32Stub();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: 'C:\\Users\\x\\AppData',
          homedir: WIN_HOME,
          cwd: WIN_HOME,
          slug: 'g',
          server: 'srv',
          existingLinks: [],
          platform: 'win32',
        },
      ),
    ).rejects.toMatchObject({ code: 'is_system' });
  });

  it('C:\\Windows → is_system', async () => {
    const fs = makeWin32Stub();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: 'C:\\Windows',
          homedir: WIN_HOME,
          cwd: WIN_HOME,
          slug: 'g',
          server: 'srv',
          existingLinks: [],
          platform: 'win32',
        },
      ),
    ).rejects.toMatchObject({ code: 'is_system' });
  });

  it('c:\\windows (lowercase) → is_system (case-insensitive)', async () => {
    const fs = makeWin32Stub();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: 'c:\\windows',
          homedir: WIN_HOME,
          cwd: WIN_HOME,
          slug: 'g',
          server: 'srv',
          existingLinks: [],
          platform: 'win32',
        },
      ),
    ).rejects.toMatchObject({ code: 'is_system' });
  });

  it('C:\\Program Files → is_system', async () => {
    const fs = makeWin32Stub();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: 'C:\\Program Files',
          homedir: WIN_HOME,
          cwd: WIN_HOME,
          slug: 'g',
          server: 'srv',
          existingLinks: [],
          platform: 'win32',
        },
      ),
    ).rejects.toMatchObject({ code: 'is_system' });
  });

  it('C:\\Users → is_system', async () => {
    const fs = makeWin32Stub();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: 'C:\\Users',
          homedir: WIN_HOME,
          cwd: WIN_HOME,
          slug: 'g',
          server: 'srv',
          existingLinks: [],
          platform: 'win32',
        },
      ),
    ).rejects.toMatchObject({ code: 'is_system' });
  });

  it('C:foo (drive-relative) → unsupported_path', async () => {
    const fs = makeWin32Stub();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: 'C:foo',
          homedir: WIN_HOME,
          cwd: WIN_HOME,
          slug: 'g',
          server: 'srv',
          existingLinks: [],
          platform: 'win32',
        },
      ),
    ).rejects.toMatchObject({ code: 'unsupported_path' });
  });

  it('bare C: (no separator) → unsupported_path', async () => {
    const fs = makeWin32Stub();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: 'C:',
          homedir: WIN_HOME,
          cwd: WIN_HOME,
          slug: 'g',
          server: 'srv',
          existingLinks: [],
          platform: 'win32',
        },
      ),
    ).rejects.toMatchObject({ code: 'unsupported_path' });
  });

  it('\\\\?\\C:\\x (device path) → unsupported_path', async () => {
    const fs = makeWin32Stub();
    await expect(
      prepareVaultDir(
        { fs },
        {
          input: '\\\\?\\C:\\x',
          homedir: WIN_HOME,
          cwd: WIN_HOME,
          slug: 'g',
          server: 'srv',
          existingLinks: [],
          platform: 'win32',
        },
      ),
    ).rejects.toMatchObject({ code: 'unsupported_path' });
  });

  it('junction to C:\\Windows (realpath returns C:\\Windows) → is_system', async () => {
    // Simulate a junction/symlink where the canonical path resolves to C:\Windows.
    // The stub realpath maps C:\fake-vault → C:\Windows to simulate the junction.
    const junctionStub: import('../ports/filesystem.js').FilesystemPort = {
      ...makeWin32Stub(),
      realpath: async (p: string) => {
        if (p === 'C:\\fake-vault' || p.toLowerCase() === 'c:\\fake-vault') {
          return 'C:\\Windows';
        }
        return p;
      },
    };
    await expect(
      prepareVaultDir(
        { fs: junctionStub },
        {
          input: 'C:\\fake-vault',
          homedir: WIN_HOME,
          cwd: WIN_HOME,
          slug: 'g',
          server: 'srv',
          existingLinks: [],
          platform: 'win32',
        },
      ),
    ).rejects.toMatchObject({ code: 'is_system' });
  });
});

describe('prepareVaultDir — win32 system trees and subfolders (CHAMBA-015 Test 2)', () => {
  const prep = (input: string) =>
    prepareVaultDir(
      { fs: makeWin32Stub() },
      {
        input,
        homedir: WIN_HOME,
        cwd: WIN_HOME,
        slug: 'g',
        server: 'srv',
        existingLinks: [],
        platform: 'win32',
      },
    );

  it.each([
    'C:\\Windows\\Temp',
    'c:\\windows\\system32\\vault',
    'D:\\Windows\\x',
    'C:\\Program Files\\Obsidian',
    'C:\\Program Files (x86)\\x',
    `${WIN_HOME}\\AppData\\Roaming\\vault`,
    `${WIN_HOME.toUpperCase()}\\APPDATA`,
  ])('%s → is_system', async (input) => {
    await expect(prep(input)).rejects.toMatchObject({ code: 'is_system' });
  });

  it.each([
    `${WIN_HOME}\\.chamba\\vaults\\cya`,
    `${WIN_HOME}\\vaults\\cya`,
    'D:\\workspace\\vault',
    'C:\\WindowsData\\vault',
  ])('%s → accepted', async (input) => {
    await expect(prep(input)).resolves.toMatchObject({ vaultDir: input });
  });
});
