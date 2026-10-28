import { describe, expect, it } from 'vitest';
import {
  applyPushResults,
  type LocalSnapshot,
  type PullAction,
  planPull,
  planPush,
  type SyncState,
} from './plan.js';
import type { ChangeEntry } from './protocol.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const C = 'c'.repeat(64);

function makeEntry(path: string, hash: string | null, seq = 1): ChangeEntry {
  return {
    seq,
    path,
    hash,
    author: 'remote-user',
    device: 'device-1',
    at: '2026-01-01T00:00:00Z',
  };
}

// ─── planPush — AC8 ───────────────────────────────────────────────────────────

describe('planPush — AC8', () => {
  it('returns exactly 3 changes: new, modified, deleted (unchanged skipped)', () => {
    // State has: modified.md (synced A), deleted.md (synced A), unchanged.md (synced B)
    // Local has: modified.md (B, changed), unchanged.md (B, same as synced), new.md (C, new)
    // Expected pushes: new.md (new), modified.md (modified), deleted.md (deleted) — 3 total
    const state: SyncState = {
      cursor: 5,
      files: {
        'modified.md': { syncedHash: A },
        'deleted.md': { syncedHash: A },
        'unchanged.md': { syncedHash: B },
      },
    };
    const local: LocalSnapshot = {
      'unchanged.md': B, // unchanged (L === S)
      'modified.md': B, // modified (L !== S)
      'new.md': C, // new (not in state)
    };

    const changes = planPush(state, local);
    expect(changes).toHaveLength(3);
    const byPath = Object.fromEntries(changes.map((c) => [c.path, c]));
    expect(byPath['new.md']).toMatchObject({ baseHash: null, newHash: C });
    expect(byPath['modified.md']).toMatchObject({ baseHash: A, newHash: B });
    expect(byPath['deleted.md']).toMatchObject({ baseHash: A, newHash: null });
    expect(byPath['unchanged.md']).toBeUndefined();
  });

  it('is sorted by path', () => {
    const state: SyncState = {
      cursor: 0,
      files: {
        'z.md': { syncedHash: A },
        'a.md': { syncedHash: null },
      },
    };
    const local: LocalSnapshot = { 'z.md': B, 'b.md': C };
    const changes = planPush(state, local);
    const paths = changes.map((c) => c.path);
    expect(paths).toEqual([...paths].sort());
  });

  it('skips known tombstones', () => {
    const state: SyncState = {
      cursor: 0,
      files: { 'gone.md': { syncedHash: null } },
    };
    const local: LocalSnapshot = {};
    expect(planPush(state, local)).toHaveLength(0);
  });
});

// ─── planPull — AC9 ───────────────────────────────────────────────────────────

describe('planPull — AC9 rules', () => {
  const opts = { localAuthor: 'vale' };

  it('rule 1: R === L → noop (both same hash)', () => {
    const state: SyncState = { cursor: 0, files: { 'a.md': { syncedHash: A } } };
    const local: LocalSnapshot = { 'a.md': B };
    const remote = [makeEntry('a.md', B)];
    const plan = planPull(state, local, remote, opts);
    expect(plan.actions[0]).toMatchObject({ type: 'noop', path: 'a.md' });
  });

  it('rule 1: both deleted → noop', () => {
    const state: SyncState = { cursor: 0, files: { 'a.md': { syncedHash: A } } };
    const local: LocalSnapshot = {}; // locally deleted
    const remote = [makeEntry('a.md', null)]; // R = null
    const plan = planPull(state, local, remote, opts);
    // L = null, R = null → R === L → noop
    expect(plan.actions[0]).toMatchObject({ type: 'noop' });
  });

  it('rule 2: local unchanged, remote non-null → write', () => {
    const state: SyncState = { cursor: 0, files: { 'a.md': { syncedHash: A } } };
    const local: LocalSnapshot = { 'a.md': A }; // L === S
    const remote = [makeEntry('a.md', B)]; // R = B
    const plan = planPull(state, local, remote, opts);
    expect(plan.actions[0]).toMatchObject({ type: 'write', path: 'a.md', hash: B });
  });

  it('rule 2: new remote file (S=null, L=null, R=hash) → write', () => {
    const state: SyncState = { cursor: 0, files: {} };
    const local: LocalSnapshot = {};
    const remote = [makeEntry('new.md', A)];
    const plan = planPull(state, local, remote, opts);
    expect(plan.actions[0]).toMatchObject({ type: 'write', path: 'new.md', hash: A });
  });

  it('rule 3: local unchanged, remote null → delete', () => {
    const state: SyncState = { cursor: 0, files: { 'a.md': { syncedHash: A } } };
    const local: LocalSnapshot = { 'a.md': A }; // L === S
    const remote = [makeEntry('a.md', null)]; // tombstone
    const plan = planPull(state, local, remote, opts);
    expect(plan.actions[0]).toMatchObject({ type: 'delete', path: 'a.md' });
  });

  it('rule 4: local deleted, remote non-null → write', () => {
    const state: SyncState = { cursor: 0, files: { 'a.md': { syncedHash: A } } };
    const local: LocalSnapshot = {}; // L = null (deleted), S = A
    const remote = [makeEntry('a.md', B)]; // R = B
    const plan = planPull(state, local, remote, opts);
    expect(plan.actions[0]).toMatchObject({ type: 'write', path: 'a.md', hash: B });
  });

  it('rule 5: both changed differently → conflict', () => {
    const state: SyncState = { cursor: 0, files: { 'a.md': { syncedHash: A } } };
    const local: LocalSnapshot = { 'a.md': B }; // L = B ≠ S = A
    const remote = [makeEntry('a.md', C)]; // R = C
    const plan = planPull(state, local, remote, opts);
    const action = plan.actions[0];
    expect(action?.type).toBe('conflict');
    if (action?.type === 'conflict') {
      expect(action.localHash).toBe(B);
      expect(action.remoteHash).toBe(C);
      expect(action.copyPath).not.toBe(action.path);
      expect(action.base).toBe(A); // D1: syncedHash
    }
  });

  it('rule 6: local modified, remote deleted → conflict', () => {
    const state: SyncState = { cursor: 0, files: { 'a.md': { syncedHash: A } } };
    const local: LocalSnapshot = { 'a.md': B }; // L = B ≠ S = A
    const remote = [makeEntry('a.md', null)]; // R = null
    const plan = planPull(state, local, remote, opts);
    const action = plan.actions[0];
    expect(action?.type).toBe('conflict');
    if (action?.type === 'conflict') {
      expect(action.remoteHash).toBeNull();
      expect(action.localHash).toBe(B);
    }
  });

  it('multiple entries per path: max seq wins', () => {
    const state: SyncState = { cursor: 0, files: { 'a.md': { syncedHash: A } } };
    const local: LocalSnapshot = { 'a.md': A };
    const remote = [makeEntry('a.md', B, 2), makeEntry('a.md', C, 5), makeEntry('a.md', A, 1)];
    const plan = planPull(state, local, remote, opts);
    // seq=5 wins → R = C; L = A = S, R = C ≠ L → write
    expect(plan.actions[0]).toMatchObject({ type: 'write', hash: C });
  });

  it('advances cursor to max seq', () => {
    const state: SyncState = { cursor: 3, files: {} };
    const remote = [makeEntry('a.md', A, 2), makeEntry('b.md', B, 7)];
    const plan = planPull(state, {}, remote, opts);
    expect(plan.cursor).toBe(7);
  });

  it('keeps cursor when all seqs lower', () => {
    const state: SyncState = { cursor: 10, files: {} };
    const remote = [makeEntry('a.md', A, 2)];
    const plan = planPull(state, {}, remote, opts);
    expect(plan.cursor).toBe(10);
  });
});

describe('planPull — AC9 conflict invariant (B2 copyPath collision)', () => {
  const opts = { localAuthor: 'vale' };

  it('copyPath collision test: remote writes conflict copy name', () => {
    // Remote has an entry at 'foo (conflicto vale).md'
    // Also conflicts on 'foo.md' → copy must be 'foo (conflicto vale 2).md'
    const state: SyncState = {
      cursor: 0,
      files: { 'foo.md': { syncedHash: A } },
    };
    const local: LocalSnapshot = { 'foo.md': B };
    const remote = [
      makeEntry('foo (conflicto vale).md', C, 1), // remote writes this path
      makeEntry('foo.md', C, 2), // conflicts
    ];
    const plan = planPull(state, local, remote, opts);
    const conflict = plan.actions.find((a) => a.type === 'conflict');
    expect(conflict?.type).toBe('conflict');
    if (conflict?.type === 'conflict') {
      expect(conflict.copyPath).toBe('foo (conflicto vale 2).md');
    }
  });
});

describe('planPull — AC9 exhaustive (S,L,R) invariant', () => {
  const opts = { localAuthor: 'author' };
  const values = [null, A, B, C];

  // For every (S, L, R) combination with a remote entry:
  //   (a) exactly one action per remote path
  //   (b) if the file was locally modified (L !== null AND L !== S), it is never lost:
  //       the action must be `conflict` with localHash === L
  it('every (S, L, R) combination produces exactly one action and preserves locally-modified L', () => {
    let count = 0;
    for (const S of values) {
      for (const L of values) {
        for (const R of values) {
          const files: SyncState['files'] = S !== null ? { 'x.md': { syncedHash: S } } : {};
          const state: SyncState = { cursor: 0, files };
          const local: LocalSnapshot = L !== null ? { 'x.md': L } : {};
          const remote: ChangeEntry[] = [makeEntry('x.md', R)];

          const plan = planPull(state, local, remote, opts);
          // (a) Exactly one action per remote path
          expect(plan.actions).toHaveLength(1);
          const action = plan.actions[0] as PullAction;

          // (b) Locally-modified files must be captured in a conflict
          const locallyModified = L !== null && L !== S;
          if (locallyModified) {
            // Rule 1 special case: R === L means both sides converged on same value — noop is fine
            if (R !== L) {
              // Must be conflict (rules 5 or 6)
              expect(action.type).toBe('conflict');
              if (action.type === 'conflict') {
                expect(action.localHash).toBe(L);
                expect(action.localHash).not.toBeNull();
                expect(action.copyPath).toBeDefined();
                expect(action.copyPath).not.toBe(action.path);
              }
            }
          }
          count++;
        }
      }
    }
    expect(count).toBe(values.length ** 3); // 4^3 = 64
  });
});

// ─── applyPushResults — AC10 ──────────────────────────────────────────────────

describe('applyPushResults — AC10', () => {
  it('only ok results advance syncedHash', () => {
    const state: SyncState = {
      cursor: 5,
      files: {
        'ok.md': { syncedHash: A },
        'conflict.md': { syncedHash: A },
        'missing.md': { syncedHash: A },
      },
    };
    const request = [
      { path: 'ok.md', baseHash: A, newHash: B },
      { path: 'conflict.md', baseHash: A, newHash: C },
      { path: 'missing.md', baseHash: A, newHash: B },
    ];
    const response = {
      results: [
        { status: 'ok' as const, path: 'ok.md' },
        { status: 'conflict' as const, path: 'conflict.md' },
        // 'missing.md' has no result
      ],
    };

    const next = applyPushResults(state, request, response);

    expect(next.files['ok.md']?.syncedHash).toBe(B);
    expect(next.files['conflict.md']?.syncedHash).toBe(A); // unchanged
    expect(next.files['missing.md']?.syncedHash).toBe(A); // unchanged
  });

  it('delete ok advances to null tombstone', () => {
    const state: SyncState = {
      cursor: 1,
      files: { 'del.md': { syncedHash: A } },
    };
    const request = [{ path: 'del.md', baseHash: A, newHash: null }];
    const response = { results: [{ status: 'ok' as const, path: 'del.md' }] };
    const next = applyPushResults(state, request, response);
    expect(next.files['del.md']?.syncedHash).toBeNull();
  });

  it('does not mutate input state', () => {
    const state: SyncState = { cursor: 1, files: { 'x.md': { syncedHash: A } } };
    const request = [{ path: 'x.md', baseHash: A, newHash: B }];
    const response = { results: [{ status: 'ok' as const, path: 'x.md' }] };
    applyPushResults(state, request, response);
    expect(state.files['x.md']?.syncedHash).toBe(A); // original unchanged
  });

  it('ignores an ok result for a path that was not in the request', () => {
    const state: SyncState = { cursor: 1, files: { 'x.md': { syncedHash: A } } };
    const request = [{ path: 'x.md', baseHash: A, newHash: B }];
    const response = {
      results: [
        { status: 'ok' as const, path: 'x.md' },
        { status: 'ok' as const, path: 'stray.md' },
      ],
    };
    const next = applyPushResults(state, request, response);
    expect(next.files['x.md']?.syncedHash).toBe(B);
    expect('stray.md' in next.files).toBe(false);
  });

  it('cursor is unchanged', () => {
    const state: SyncState = { cursor: 42, files: {} };
    const next = applyPushResults(state, [], { results: [] });
    expect(next.cursor).toBe(42);
  });
});

describe('planPull — conflict copyPaths are distinct', () => {
  it('two conflicting files get distinct copyPaths', () => {
    const state: SyncState = {
      cursor: 0,
      files: {
        'a.md': { syncedHash: A },
        'b.md': { syncedHash: A },
      },
    };
    const local: LocalSnapshot = { 'a.md': B, 'b.md': B };
    const remote = [makeEntry('a.md', C, 1), makeEntry('b.md', C, 2)];
    const plan = planPull(state, local, remote, { localAuthor: 'same' });
    const conflicts = plan.actions.filter((a) => a.type === 'conflict') as Array<{
      type: 'conflict';
      copyPath: string;
    }>;
    expect(conflicts).toHaveLength(2);
    const copyPaths = conflicts.map((c) => c.copyPath);
    expect(new Set(copyPaths).size).toBe(2);
  });
});
