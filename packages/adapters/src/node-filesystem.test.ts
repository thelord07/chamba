/**
 * node-filesystem.test.ts — Tests for NodeFilesystem new methods (PARCHE-004).
 * Uses a real temp directory. Never touches ~/.chamba.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeFilesystem } from './node-filesystem.js';

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

  it('writeBytes with mode 0o600 sets file permissions', async () => {
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
    expect(result.startsWith('/')).toBe(true);
    // On macOS /var/folders/... is /private/var/folders/... after realpath
    // Just verify it ends with the same basename
    const { basename } = await import('node:path');
    expect(basename(result)).toBe(basename(dir));
  });

  it('resolves a symlink to its target (PARCHE-009 adapters)', async () => {
    const { symlink, mkdir: mkdirFs, realpath: nodeRealpath } = await import('node:fs/promises');
    const target = join(dir, 'real-dir');
    const link = join(dir, 'symlink-to-dir');
    await mkdirFs(target);
    await symlink(target, link);

    const result = await fs.realpath(link);
    const expected = await nodeRealpath(target);
    expect(result).toBe(expected);
  });

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
