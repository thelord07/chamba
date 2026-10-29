/**
 * credentials.test.ts — CredentialsStore unit tests.
 * Uses MemoryFilesystem. Never touches the real home directory.
 */

import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { CredentialsStore } from './credentials.js';

const HOME = '/home/user';
const SERVER = 'https://parche.example.com';
const SLUG = 'my-group';

const ENTRY = {
  token: 'pch_test_abc123',
  user: { id: 'usr1', name: 'Joys' },
  device: { id: 'dev1', label: 'laptop' },
  role: 'editor' as const,
};

describe('CredentialsStore — set / get', () => {
  it('round-trips a credential entry', async () => {
    const fs = new MemoryFilesystem();
    const store = new CredentialsStore(fs, HOME);

    await store.set(SERVER, SLUG, ENTRY);
    const got = await store.get(SERVER, SLUG);
    expect(got).toEqual(ENTRY);
  });

  it('returns null for missing key', async () => {
    const fs = new MemoryFilesystem();
    const store = new CredentialsStore(fs, HOME);
    expect(await store.get(SERVER, SLUG)).toBeNull();
  });

  it('writes credentials.json outside the vault, inside ~/.chamba/', async () => {
    const fs = new MemoryFilesystem();
    const store = new CredentialsStore(fs, HOME);
    await store.set(SERVER, SLUG, ENTRY);

    // Path must be ~/.chamba/credentials.json
    const expectedPath = `${HOME}/.chamba/credentials.json`;
    expect(await fs.exists(expectedPath)).toBe(true);
    // Must not exist at vault root
    expect(await fs.exists('/vault/credentials.json')).toBe(false);
  });

  it('writes credentials.json with mode 0o600', async () => {
    const fs = new MemoryFilesystem();
    const store = new CredentialsStore(fs, HOME);
    await store.set(SERVER, SLUG, ENTRY);

    const mode = fs.getMode(`${HOME}/.chamba/credentials.json`);
    expect(mode).toBe(0o600);
  });

  it('token does not appear in listSlugs() output', async () => {
    const fs = new MemoryFilesystem();
    const store = new CredentialsStore(fs, HOME);
    await store.set(SERVER, SLUG, ENTRY);

    const slugs = await store.listSlugs();
    // listSlugs returns {server, slug} pairs — never the token
    for (const s of slugs) {
      expect(JSON.stringify(s)).not.toContain(ENTRY.token);
    }
    expect(slugs).toEqual([{ server: SERVER, slug: SLUG }]);
  });
});

describe('CredentialsStore — remove', () => {
  it('remove drops only that key, leaves others intact', async () => {
    const fs = new MemoryFilesystem();
    const store = new CredentialsStore(fs, HOME);

    const entry2 = { ...ENTRY, token: 'pch_other', user: { id: 'usr2', name: 'Other' } };
    await store.set(SERVER, SLUG, ENTRY);
    await store.set(SERVER, 'other-group', entry2);

    await store.remove(SERVER, SLUG);

    expect(await store.get(SERVER, SLUG)).toBeNull();
    expect(await store.get(SERVER, 'other-group')).toEqual(entry2);
  });

  it('remove on nonexistent key is a no-op', async () => {
    const fs = new MemoryFilesystem();
    const store = new CredentialsStore(fs, HOME);
    // Should not throw
    await expect(store.remove(SERVER, SLUG)).resolves.toBeUndefined();
  });
});

describe('CredentialsStore — listSlugs', () => {
  it('returns all stored (server, slug) pairs', async () => {
    const fs = new MemoryFilesystem();
    const store = new CredentialsStore(fs, HOME);
    const entry2 = { ...ENTRY, token: 'pch_other2' };
    await store.set(SERVER, SLUG, ENTRY);
    await store.set('https://other.server', 'slug2', entry2);

    const slugs = await store.listSlugs();
    expect(slugs).toHaveLength(2);
    expect(slugs).toContainEqual({ server: SERVER, slug: SLUG });
    expect(slugs).toContainEqual({ server: 'https://other.server', slug: 'slug2' });
  });

  it('returns empty array when no credentials stored', async () => {
    const fs = new MemoryFilesystem();
    const store = new CredentialsStore(fs, HOME);
    expect(await store.listSlugs()).toEqual([]);
  });
});
