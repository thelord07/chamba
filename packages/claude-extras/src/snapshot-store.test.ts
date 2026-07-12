import { MemoryFilesystem } from '@chamba/core';
import { describe, expect, it } from 'vitest';
import { SnapshotStore } from './snapshot-store.js';

function build() {
  const fs = new MemoryFilesystem({});
  let clock = '2026-07-12T10:00:00.000Z';
  const store = new SnapshotStore(fs, '/backups', () => clock);
  const setClock = (t: string) => {
    clock = t;
  };
  const snap = (n: number) => [{ path: '.claude.json', content: `{"v":${n}}` }];
  return { fs, store, setClock, snap };
}

describe('SnapshotStore', () => {
  it('saves a snapshot and loads its files back', async () => {
    const { store, snap } = build();
    const { deduped, meta } = await store.save(snap(1), 'install --force');
    expect(deduped).toBe(false);
    expect(meta.reason).toBe('install --force');
    expect(meta.fileCount).toBe(1);

    const loaded = await store.load();
    expect(loaded?.files).toEqual([{ path: '.claude.json', content: '{"v":1}' }]);
  });

  it('dedups an identical consecutive snapshot', async () => {
    const { store, snap, setClock } = build();
    await store.save(snap(1), 'first');
    setClock('2026-07-12T11:00:00.000Z');
    const second = await store.save(snap(1), 'second');

    expect(second.deduped).toBe(true);
    expect(await store.list()).toHaveLength(1);
  });

  it('lists snapshots newest first and loads by id', async () => {
    const { store, snap, setClock } = build();
    await store.save(snap(1), 'a');
    setClock('2026-07-12T11:00:00.000Z');
    await store.save(snap(2), 'b');

    const list = await store.list();
    expect(list).toHaveLength(2);
    expect(list[0]?.reason).toBe('b'); // newest first
    const oldest = list[1];
    if (!oldest) throw new Error('expected two snapshots');
    const loaded = await store.load(oldest.id);
    expect(loaded?.files[0]?.content).toBe('{"v":1}');
  });

  it('prunes the oldest unpinned snapshots beyond keep, sparing pinned', async () => {
    const { store, snap, setClock } = build();
    await store.save(snap(1), 'oldest');
    setClock('2026-07-12T11:00:00.000Z');
    await store.save(snap(2), 'middle');
    setClock('2026-07-12T12:00:00.000Z');
    await store.save(snap(3), 'newest');

    const oldest = (await store.list()).at(-1);
    if (!oldest) throw new Error('expected snapshots');
    await store.pin(oldest.id);

    const removed = await store.prune(1); // keep newest 1 unpinned + all pinned
    expect(removed).toHaveLength(1); // the 'middle' one
    const remaining = (await store.list()).map((m) => m.reason).sort();
    expect(remaining).toEqual(['newest', 'oldest']); // pinned oldest survived
  });

  it('returns null loading from an empty store', async () => {
    const { store } = build();
    expect(await store.load()).toBeNull();
    expect(await store.list()).toEqual([]);
  });
});
