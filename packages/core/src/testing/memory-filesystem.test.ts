import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from './memory-filesystem.js';

describe('MemoryFilesystem — new methods', () => {
  it('readBytes / writeBytes round-trip', async () => {
    const fs = new MemoryFilesystem();
    const data = new TextEncoder().encode('hello bytes');
    await fs.writeBytes('/vault/a.md', data);
    const back = await fs.readBytes('/vault/a.md');
    expect(back).toEqual(data);
  });

  it('writeBytes records mode', async () => {
    const fs = new MemoryFilesystem();
    const data = new Uint8Array([1, 2, 3]);
    await fs.writeBytes('/home/.chamba/credentials.json', data, { mode: 0o600 });
    expect(fs.getMode('/home/.chamba/credentials.json')).toBe(0o600);
  });

  it('writeBytes without mode leaves mode undefined', async () => {
    const fs = new MemoryFilesystem();
    await fs.writeBytes('/vault/state.json', new Uint8Array([1]));
    expect(fs.getMode('/vault/state.json')).toBeUndefined();
  });

  it('stat returns size and mtime for a bytes file', async () => {
    const fs = new MemoryFilesystem();
    const data = new Uint8Array([1, 2, 3, 4, 5]);
    await fs.writeBytes('/vault/img.png', data);
    const s = await fs.stat('/vault/img.png');
    expect(s).not.toBeNull();
    if (!s) throw new Error('stat returned null');
    expect(s.size).toBe(5);
    expect(s.mtimeMs).toBeGreaterThan(0);
  });

  it('stat returns size for a text file', async () => {
    const fs = new MemoryFilesystem({ '/vault/note.md': '# Title' });
    const s = await fs.stat('/vault/note.md');
    expect(s).not.toBeNull();
    if (!s) throw new Error('stat returned null');
    expect(s.size).toBeGreaterThan(0);
  });

  it('stat returns null for ENOENT', async () => {
    const fs = new MemoryFilesystem();
    const s = await fs.stat('/vault/missing.md');
    expect(s).toBeNull();
  });

  it('rename moves a bytes file', async () => {
    const fs = new MemoryFilesystem();
    const data = new Uint8Array([7, 8, 9]);
    await fs.writeBytes('/vault/old.md', data);
    await fs.rename('/vault/old.md', '/vault/new.md');
    expect(await fs.exists('/vault/old.md')).toBe(false);
    expect(await fs.exists('/vault/new.md')).toBe(true);
    expect(await fs.readBytes('/vault/new.md')).toEqual(data);
  });

  it('rename moves a text file', async () => {
    const fs = new MemoryFilesystem({ '/vault/a.md': 'content' });
    await fs.rename('/vault/a.md', '/vault/b.md');
    expect(await fs.exists('/vault/a.md')).toBe(false);
    expect(await fs.readFile('/vault/b.md')).toBe('content');
  });

  it('rename throws ENOENT for missing source', async () => {
    const fs = new MemoryFilesystem();
    await expect(fs.rename('/vault/missing.md', '/vault/other.md')).rejects.toThrow('ENOENT');
  });

  it('rename preserves mode', async () => {
    const fs = new MemoryFilesystem();
    await fs.writeBytes('/home/creds.json', new Uint8Array([1]), { mode: 0o600 });
    await fs.rename('/home/creds.json', '/home/creds2.json');
    expect(fs.getMode('/home/creds2.json')).toBe(0o600);
  });

  it('readBytes falls back to text content', async () => {
    const fs = new MemoryFilesystem({ '/vault/note.md': 'hello' });
    const bytes = await fs.readBytes('/vault/note.md');
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });

  it('readBytes throws ENOENT for missing file', async () => {
    const fs = new MemoryFilesystem();
    await expect(fs.readBytes('/vault/missing.md')).rejects.toThrow('ENOENT');
  });

  it('readFile can read bytes-only file as UTF-8', async () => {
    const fs = new MemoryFilesystem();
    await fs.writeBytes('/vault/a.md', new TextEncoder().encode('from bytes'));
    const text = await fs.readFile('/vault/a.md');
    expect(text).toBe('from bytes');
  });

  it('readDir lists bytes files', async () => {
    const fs = new MemoryFilesystem();
    await fs.writeBytes('/vault/a.md', new Uint8Array([1]));
    await fs.writeBytes('/vault/b.png', new Uint8Array([2]));
    const entries = await fs.readDir('/vault');
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(['a.md', 'b.png']);
  });

  it('remove deletes bytes files', async () => {
    const fs = new MemoryFilesystem();
    await fs.writeBytes('/vault/a.md', new Uint8Array([1]));
    await fs.remove('/vault/a.md');
    expect(await fs.exists('/vault/a.md')).toBe(false);
  });
});
