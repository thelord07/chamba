/**
 * node-filesystem.test.ts — Tests for NodeFilesystem new methods (PARCHE-004).
 * Uses a real temp directory. Never touches ~/.chamba.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeFilesystem } from './node-filesystem.js';

// S13: helpers for POSIX-only test skips
const isWin32 = process.platform === 'win32';

let dir: string;
let fs: NodeFilesystem;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'chamba-test-'));
  fs = new NodeFilesystem();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('NodeFilesystem — stat', () => {
  it('returns size and mtimeMs for an existing file', async () => {
    const path = join(dir, 'test.txt');
    await fs.writeFile(path, 'hello world');
    const stat = await fs.stat(path);
    expect(stat).not.toBeNull();
    if (!stat) throw new Error('stat returned null');
    expect(stat.size).toBeGreaterThan(0);
    expect(stat.mtimeMs).toBeGreaterThan(0);
  });

  it('returns null for ENOENT', async () => {
    const stat = await fs.stat(join(dir, 'nonexistent.txt'));
    expect(stat).toBeNull();
  });
});

describe('NodeFilesystem — readBytes / writeBytes', () => {
  it('round-trips bytes', async () => {
    const path = join(dir, 'data.bin');
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await fs.writeBytes(path, data);
    const back = await fs.readBytes(path);
    expect(back).toEqual(data);
  });

  // S13: mode bits (chmod/0o600) are a POSIX concept; Windows NTFS ignores them.
  // On Windows, file security is enforced via ACLs (icacls — see S18 / secureFile).
  it.skipIf(isWin32)('writeBytes with mode 0o600 sets file permissions (POSIX only)', async () => {
    const path = join(dir, 'creds.json');
    const data = new TextEncoder().encode('{"token":"secret"}');
    await fs.writeBytes(path, data, { mode: 0o600 });

    const stat = await import('node:fs/promises').then((m) => m.stat(path));
    // On POSIX, mode & 0o777 should be 0o600
    const mode = stat.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('writeBytes is atomic (file appears fully written)', async () => {
    const path = join(dir, 'atomic.txt');
    const data = new TextEncoder().encode('atomic content');
    await fs.writeBytes(path, data);
    const back = await fs.readBytes(path);
    expect(new TextDecoder().decode(back)).toBe('atomic content');
  });
});

describe('NodeFilesystem — rename', () => {
  it('moves a file', async () => {
    const src = join(dir, 'src.txt');
    const dst = join(dir, 'dst.txt');
    await fs.writeFile(src, 'content');
    await fs.rename(src, dst);
    expect(await fs.exists(src)).toBe(false);
    expect(await fs.exists(dst)).toBe(true);
    expect(await fs.readFile(dst)).toBe('content');
  });
});

describe('NodeFilesystem — realpath (PARCHE-009 adapters)', () => {
  it('resolves an existing dir to its real path', async () => {
    const result = await fs.realpath(dir);
    // Result should be an absolute path containing the temp dir base name
    expect(result).toBeTruthy();
    const { basename } = await import('node:path');
    expect(basename(result)).toBe(basename(dir));
    // S13: On POSIX the real path starts with '/'; on Windows it starts with a drive letter.
    if (!isWin32) {
      expect(result.startsWith('/')).toBe(true);
    } else {
      expect(result).toMatch(/^[A-Za-z]:\\/);
    }
  });

  // S13: symlink creation requires unprivileged symlink support; on Windows this
  // requires Developer Mode or elevated privileges that are not guaranteed in CI.
  it.skipIf(isWin32)(
    'resolves a symlink to its target (PARCHE-009 adapters, POSIX only)',
    async () => {
      const { symlink, mkdir: mkdirFs, realpath: nodeRealpath } = await import('node:fs/promises');
      const target = join(dir, 'real-dir');
      const link = join(dir, 'symlink-to-dir');
      await mkdirFs(target);
      await symlink(target, link);

      const result = await fs.realpath(link);
      const expected = await nodeRealpath(target);
      expect(result).toBe(expected);
    },
  );

  it('resolves a non-existent leaf to realpath(ancestor)+rest (PARCHE-009 adapters)', async () => {
    const { realpath: nodeRealpath } = await import('node:fs/promises');
    const nonExistentLeaf = join(dir, 'does-not-exist', 'sub');
    const result = await fs.realpath(nonExistentLeaf);
    // The ancestor (dir) exists; result should be realpath(dir)+/does-not-exist/sub
    const resolvedAncestor = await nodeRealpath(dir);
    const { join: pathJoin } = await import('node:path');
    expect(result).toBe(pathJoin(resolvedAncestor, 'does-not-exist', 'sub'));
  });
});

describe('NodeHash', () => {
  it('sha256 matches FakeHash on the same input', async () => {
    const { NodeHash } = await import('./node-hash.js');
    const { FakeHash } = await import('@chamba/core');

    const nodeHash = new NodeHash();
    const fakeHash = new FakeHash();
    const data = new TextEncoder().encode('test data for hashing');

    const nodeResult = await nodeHash.sha256(data);
    const fakeResult = await fakeHash.sha256(data);

    expect(nodeResult).toBe(fakeResult);
    expect(nodeResult).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ─── S18: Test 5 — credentials ACL (secureFile, CHAMBA-015) ──────────────────

describe('S18 / Test 5 — NodeFilesystem.secureFile (CHAMBA-015 S8)', () => {
  it('win32: calls icacls with exact args [path, /inheritance:r, /grant:r, <user>:(F)]', async () => {
    const { NodeFilesystem } = await import('./node-filesystem.js');

    const icaclsCalls: Array<{ cmd: string; args: string[] }> = [];
    const mockExecFn = async (cmd: string, args: string[]) => {
      icaclsCalls.push({ cmd, args });
      return { stdout: '', stderr: '' };
    };

    const fsWin = new NodeFilesystem({
      platform: 'win32',
      username: 'testuser',
      execFn: mockExecFn,
    });

    const testPath = join(dir, 'creds.json');
    await fsWin.writeFile(testPath, '{}');

    const result = await fsWin.secureFile(testPath);

    expect(result.ok).toBe(true);
    expect(icaclsCalls).toHaveLength(1);
    const call = icaclsCalls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error('no call');
    expect(call.cmd).toBe('icacls');
    expect(call.args).toEqual([testPath, '/inheritance:r', '/grant:r', 'testuser:(F)']);
  });

  it('win32: exec failure → ok:false with warning, does not throw', async () => {
    const { NodeFilesystem } = await import('./node-filesystem.js');

    const failingExecFn = async (_cmd: string, _args: string[]) => {
      throw new Error('icacls: access denied');
    };

    const fsWin = new NodeFilesystem({
      platform: 'win32',
      username: 'testuser',
      execFn: failingExecFn,
    });

    const testPath = join(dir, 'creds-fail.json');
    await fsWin.writeFile(testPath, '{}');

    const result = await fsWin.secureFile(testPath);

    expect(result.ok).toBe(false);
    expect(result.warning).toBeDefined();
    expect(result.warning).toContain('icacls');
    // Token must never be in the warning
    expect(result.warning).not.toContain('pch_');
  });

  it('win32: exec failure warning is surfaced via CredentialsStore onWarn', async () => {
    const { NodeFilesystem } = await import('./node-filesystem.js');
    const { CredentialsStore } = await import('@chamba/core');

    const failingExecFn = async (_cmd: string, _args: string[]) => {
      throw new Error('icacls: domain account not found');
    };

    const fsWin = new NodeFilesystem({
      platform: 'win32',
      username: 'DOMAIN\\testuser',
      execFn: failingExecFn,
    });

    const warnings: string[] = [];
    const store = new CredentialsStore(fsWin, dir, (msg) => {
      warnings.push(msg);
    });

    await store.set('https://parche.example.com', 'my-vault', {
      token: 'pch_live_secret123',
      user: { id: 'u1', name: 'Test User' },
      device: { id: 'd1', label: 'laptop' },
      role: 'editor',
    });

    // Warning should have been called
    expect(warnings.length).toBeGreaterThan(0);
    // Token must NEVER appear in warnings
    for (const w of warnings) {
      expect(w).not.toContain('pch_live_secret123');
      expect(w).not.toContain('pch_');
    }
    // Warning should mention icacls
    expect(warnings.some((w) => w.includes('icacls'))).toBe(true);
  });

  it('posix: no exec call (no-op)', async () => {
    const { NodeFilesystem } = await import('./node-filesystem.js');

    const execCalls: string[] = [];
    const spyExecFn = async (cmd: string, _args: string[]) => {
      execCalls.push(cmd);
      return { stdout: '', stderr: '' };
    };

    const fsLinux = new NodeFilesystem({
      platform: 'linux',
      execFn: spyExecFn,
    });

    const testPath = join(dir, 'creds-posix.json');
    await fsLinux.writeFile(testPath, '{}');
    const result = await fsLinux.secureFile(testPath);

    expect(result.ok).toBe(true);
    expect(execCalls).toHaveLength(0); // no exec on posix
  });

  it('win32: icacls called after every credentials write (set, remove)', async () => {
    const { NodeFilesystem } = await import('./node-filesystem.js');
    const { CredentialsStore } = await import('@chamba/core');

    const icaclsCallCount = { n: 0 };
    const mockExecFn = async (_cmd: string, _args: string[]) => {
      icaclsCallCount.n += 1;
      return { stdout: '', stderr: '' };
    };

    const fsWin = new NodeFilesystem({
      platform: 'win32',
      username: 'testuser',
      execFn: mockExecFn,
    });

    const store = new CredentialsStore(fsWin, dir);

    // set → triggers a write → secureFile called
    await store.set('https://parche.example.com', 'vault1', {
      token: 'pch_live_tok1',
      user: { id: 'u1', name: 'User' },
      device: { id: 'd1', label: 'dev' },
      role: 'editor',
    });
    expect(icaclsCallCount.n).toBe(1);

    // remove → triggers another write → secureFile called again
    await store.remove('https://parche.example.com', 'vault1');
    expect(icaclsCallCount.n).toBe(2);
  });
});
