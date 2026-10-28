import { describe, expect, it } from 'vitest';
import { pathKey } from './path-key.js';
import {
  applyPullPlan,
  applyPushResults,
  type LocalSnapshot,
  type PullAction,
  type PullPlan,
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
    expect(plan.actions[0]).toMatchObject({ type: 'noop', path: 'a.md', hash: B });
  });

  it('rule 1: both deleted → noop', () => {
    const state: SyncState = { cursor: 0, files: { 'a.md': { syncedHash: A } } };
    const local: LocalSnapshot = {}; // locally deleted
    const remote = [makeEntry('a.md', null)]; // R = null
    const plan = planPull(state, local, remote, opts);
    // L = null, R = null → R === L → noop
    expect(plan.actions[0]).toMatchObject({ type: 'noop', hash: null });
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

// ─── Helpers for new AC tests ─────────────────────────────────────────────────

const S1 = '1'.repeat(64);
const H2 = '2'.repeat(64);
const L2 = '3'.repeat(64);

/** Case-insensitive FS simulation (Map keyed by pathKey). */
function makeSimFS(initialLocal: LocalSnapshot = {}) {
  const store = new Map<string, { path: string; hash: string | null }>();
  // Seed from local snapshot (represents files on disk)
  for (const [p, h] of Object.entries(initialLocal)) {
    store.set(pathKey(p), { path: p, hash: h });
  }

  const fs = {
    set(path: string, hash: string | null) {
      store.set(pathKey(path), { path, hash });
    },
    get(path: string): string | null {
      return store.get(pathKey(path))?.hash ?? null;
    },
    has(path: string): boolean {
      return store.has(pathKey(path));
    },
    delete(path: string) {
      store.delete(pathKey(path));
    },
    /** Apply adapter semantics in the order given (do NOT reorder). */
    apply(actions: PullAction[]) {
      for (const action of actions) {
        switch (action.type) {
          case 'conflict':
            // Step 1: write localHash to copyPath
            fs.set(action.copyPath, action.localHash);
            // Step 2a/2b: write remoteHash to path, or delete if null
            if (action.remoteHash !== null) {
              fs.set(action.path, action.remoteHash);
            } else {
              fs.delete(action.path);
            }
            break;
          case 'delete':
            fs.delete(action.path);
            break;
          case 'write':
            fs.set(action.path, action.hash);
            break;
          case 'noop':
            // nothing
            break;
        }
      }
    },
    /** Return all entries as {path → hash} (using stored casing). */
    snapshot(): Record<string, string | null> {
      const result: Record<string, string | null> = {};
      for (const { path, hash } of store.values()) {
        result[path] = hash;
      }
      return result;
    },
  };
  return fs;
}

// ─── applyPullPlan — AC5 ──────────────────────────────────────────────────────

describe('applyPullPlan — AC5: noop convergence closes false conflict', () => {
  it('state {a.md:A}, local {a.md:B}, remote a.md→B → noop → applyPullPlan → planPush → []', () => {
    const state: SyncState = { cursor: 0, files: { 'a.md': { syncedHash: A } } };
    const local: LocalSnapshot = { 'a.md': B };
    const remote = [makeEntry('a.md', B)]; // R === L
    const plan = planPull(state, local, remote, { localAuthor: 'joys' });
    expect(plan.actions[0]).toMatchObject({ type: 'noop', path: 'a.md', hash: B });
    const next = applyPullPlan(state, plan);
    expect(next.files['a.md']?.syncedHash).toBe(B);
    const pushes = planPush(next, local);
    expect(pushes).toEqual([]);
  });
});

// ─── applyPullPlan — AC6 ──────────────────────────────────────────────────────

describe('applyPullPlan — AC6: per-action syncedHash, cursor, immutability', () => {
  it('write → syncedHash = hash', () => {
    const state: SyncState = { cursor: 0, files: {} };
    const plan: PullPlan = { cursor: 5, actions: [{ type: 'write', path: 'a.md', hash: B }] };
    const next = applyPullPlan(state, plan);
    expect(next.files['a.md']?.syncedHash).toBe(B);
    expect(next.cursor).toBe(5);
  });

  it('delete → syncedHash = null', () => {
    const state: SyncState = { cursor: 0, files: { 'a.md': { syncedHash: A } } };
    const plan: PullPlan = { cursor: 3, actions: [{ type: 'delete', path: 'a.md' }] };
    const next = applyPullPlan(state, plan);
    expect(next.files['a.md']?.syncedHash).toBeNull();
  });

  it('noop → syncedHash = hash (remote hash, convergence)', () => {
    const state: SyncState = { cursor: 0, files: { 'a.md': { syncedHash: A } } };
    const plan: PullPlan = { cursor: 2, actions: [{ type: 'noop', path: 'a.md', hash: B }] };
    const next = applyPullPlan(state, plan);
    expect(next.files['a.md']?.syncedHash).toBe(B);
  });

  it('conflict → syncedHash = remoteHash; copyPath absent from files', () => {
    const state: SyncState = { cursor: 0, files: { 'a.md': { syncedHash: A } } };
    const copyPath = 'a (conflicto joys).md';
    const plan: PullPlan = {
      cursor: 4,
      actions: [{ type: 'conflict', path: 'a.md', remoteHash: C, localHash: B, copyPath, base: A }],
    };
    const next = applyPullPlan(state, plan);
    expect(next.files['a.md']?.syncedHash).toBe(C);
    expect(copyPath in next.files).toBe(false);
  });

  it('conflict with remoteHash null → syncedHash = null (tombstone wins at path)', () => {
    const state: SyncState = { cursor: 0, files: { 'a.md': { syncedHash: A } } };
    const copyPath = 'a (conflicto joys).md';
    const plan: PullPlan = {
      cursor: 4,
      actions: [
        { type: 'conflict', path: 'a.md', remoteHash: null, localHash: B, copyPath, base: A },
      ],
    };
    const next = applyPullPlan(state, plan);
    expect(next.files['a.md']?.syncedHash).toBeNull();
    expect(copyPath in next.files).toBe(false);
  });

  it('cursor = plan.cursor', () => {
    const state: SyncState = { cursor: 0, files: {} };
    const plan: PullPlan = { cursor: 99, actions: [] };
    const next = applyPullPlan(state, plan);
    expect(next.cursor).toBe(99);
  });

  it('result !== state, result.files !== state.files, original state untouched', () => {
    const state: SyncState = { cursor: 0, files: { 'a.md': { syncedHash: A } } };
    const stateClone = structuredClone(state);
    const plan: PullPlan = { cursor: 1, actions: [{ type: 'write', path: 'b.md', hash: B }] };
    const next = applyPullPlan(state, plan);
    // Identity checks
    expect(next).not.toBe(state);
    expect(next.files).not.toBe(state.files);
    // Input state untouched (deep-equal to clone taken before)
    expect(state).toEqual(stateClone);
    // New entry appears only in result
    expect('b.md' in next.files).toBe(true);
    expect('b.md' in state.files).toBe(false);
  });

  it('empty plan: actions=[], cursor=state.cursor → equivalent state with that cursor', () => {
    const state: SyncState = { cursor: 7, files: { 'a.md': { syncedHash: A } } };
    const plan: PullPlan = { cursor: 7, actions: [] };
    const next = applyPullPlan(state, plan);
    expect(next.cursor).toBe(7);
    expect(next.files['a.md']?.syncedHash).toBe(A);
    expect(next).not.toBe(state);
    expect(next.files).not.toBe(state.files);
  });
});

// ─── applyPullPlan — AC7: action ordering ─────────────────────────────────────

describe('applyPullPlan — AC7: case-rename ordering (delete before write)', () => {
  // Case unmodified: local file matches state; remote renames Nota.md → nota.md
  it('unmodified case: actions are [delete Nota.md, write nota.md H2] in that order', () => {
    const state: SyncState = { cursor: 0, files: { 'Nota.md': { syncedHash: S1 } } };
    const local: LocalSnapshot = { 'Nota.md': S1 };
    const remote = [
      makeEntry('Nota.md', null, 1), // delete old casing
      makeEntry('nota.md', H2, 2), // write new casing
    ];
    const plan = planPull(state, local, remote, { localAuthor: 'joys' });
    expect(plan.actions).toHaveLength(2);
    expect(plan.actions[0]).toMatchObject({ type: 'delete', path: 'Nota.md' });
    expect(plan.actions[1]).toMatchObject({ type: 'write', path: 'nota.md', hash: H2 });
  });

  it('unmodified case: FS simulation ends with nota.md=H2', () => {
    const state: SyncState = { cursor: 0, files: { 'Nota.md': { syncedHash: S1 } } };
    const local: LocalSnapshot = { 'Nota.md': S1 };
    const remote = [makeEntry('Nota.md', null, 1), makeEntry('nota.md', H2, 2)];
    const plan = planPull(state, local, remote, { localAuthor: 'joys' });
    const fs = makeSimFS(local);
    fs.apply(plan.actions);
    expect(fs.has('nota.md')).toBe(true);
    expect(fs.get('nota.md')).toBe(H2);
  });

  it('counter-proof (unmodified): REVERSED actions leave FS without nota.md', () => {
    const state: SyncState = { cursor: 0, files: { 'Nota.md': { syncedHash: S1 } } };
    const local: LocalSnapshot = { 'Nota.md': S1 };
    const remote = [makeEntry('Nota.md', null, 1), makeEntry('nota.md', H2, 2)];
    const plan = planPull(state, local, remote, { localAuthor: 'joys' });
    const reversed = [...plan.actions].reverse();
    const fs = makeSimFS(local);
    fs.apply(reversed);
    // write nota.md then delete Nota.md (same key on case-insensitive FS) → nota.md gone
    expect(fs.has('nota.md')).toBe(false);
  });

  it('modified case: actions are [conflict Nota.md, write nota.md H2] — conflict first', () => {
    const state: SyncState = { cursor: 0, files: { 'Nota.md': { syncedHash: S1 } } };
    const local: LocalSnapshot = { 'Nota.md': L2 }; // locally modified
    const remote = [makeEntry('Nota.md', null, 1), makeEntry('nota.md', H2, 2)];
    const plan = planPull(state, local, remote, { localAuthor: 'joys' });
    expect(plan.actions[0]).toMatchObject({ type: 'conflict', path: 'Nota.md', remoteHash: null });
    expect(plan.actions[1]).toMatchObject({ type: 'write', path: 'nota.md', hash: H2 });
  });

  it('modified case: FS simulation ends with nota.md=H2 and copy=L2', () => {
    const state: SyncState = { cursor: 0, files: { 'Nota.md': { syncedHash: S1 } } };
    const local: LocalSnapshot = { 'Nota.md': L2 };
    const remote = [makeEntry('Nota.md', null, 1), makeEntry('nota.md', H2, 2)];
    const plan = planPull(state, local, remote, { localAuthor: 'joys' });
    const fs = makeSimFS(local);
    fs.apply(plan.actions);
    expect(fs.has('nota.md')).toBe(true);
    expect(fs.get('nota.md')).toBe(H2);
    // The conflict copy must hold L2
    const conflictAction = plan.actions.find((a) => a.type === 'conflict') as
      | Extract<PullAction, { type: 'conflict' }>
      | undefined;
    expect(conflictAction).toBeDefined();
    if (conflictAction) {
      expect(fs.get(conflictAction.copyPath)).toBe(L2);
    }
  });

  it('counter-proof (modified): REVERSED actions leave FS without nota.md', () => {
    const state: SyncState = { cursor: 0, files: { 'Nota.md': { syncedHash: S1 } } };
    const local: LocalSnapshot = { 'Nota.md': L2 };
    const remote = [makeEntry('Nota.md', null, 1), makeEntry('nota.md', H2, 2)];
    const plan = planPull(state, local, remote, { localAuthor: 'joys' });
    const reversed = [...plan.actions].reverse();
    const fs = makeSimFS(local);
    fs.apply(reversed);
    // write nota.md then conflict-delete Nota.md → nota.md (= Nota.md on CI FS) gone
    expect(fs.has('nota.md')).toBe(false);
  });

  // The server can log the new casing BEFORE deleting the old one; the remote order then
  // puts the write first. Only planPull's sort keeps the delete ahead of the write.
  it('remote lists write nota.md (seq 1) before delete Nota.md (seq 2) → still delete first', () => {
    const state: SyncState = { cursor: 0, files: { 'Nota.md': { syncedHash: S1 } } };
    const local: LocalSnapshot = { 'Nota.md': S1 };
    const remote = [makeEntry('nota.md', H2, 1), makeEntry('Nota.md', null, 2)];
    const plan = planPull(state, local, remote, { localAuthor: 'joys' });
    expect(plan.actions.map((a) => a.type)).toEqual(['delete', 'write']);
    const fs = makeSimFS(local);
    fs.apply(plan.actions);
    expect(fs.get('nota.md')).toBe(H2);
  });

  it('remote lists write nota.md before delete Nota.md, local modified → conflict first, copy kept', () => {
    const state: SyncState = { cursor: 0, files: { 'Nota.md': { syncedHash: S1 } } };
    const local: LocalSnapshot = { 'Nota.md': L2 };
    const remote = [makeEntry('nota.md', H2, 1), makeEntry('Nota.md', null, 2)];
    const plan = planPull(state, local, remote, { localAuthor: 'joys' });
    expect(plan.actions.map((a) => a.type)).toEqual(['conflict', 'write']);
    const fs = makeSimFS(local);
    fs.apply(plan.actions);
    expect(fs.get('nota.md')).toBe(H2);
    const conflict = plan.actions[0];
    expect(conflict?.type === 'conflict' && fs.get(conflict.copyPath)).toBe(L2);
  });

  it('after applyPullPlan on unmodified snapshot → planPush → []', () => {
    const state: SyncState = { cursor: 0, files: { 'Nota.md': { syncedHash: S1 } } };
    const local: LocalSnapshot = { 'Nota.md': S1 };
    const remote = [makeEntry('Nota.md', null, 1), makeEntry('nota.md', H2, 2)];
    const plan = planPull(state, local, remote, { localAuthor: 'joys' });
    const next = applyPullPlan(state, plan);
    // Local after adapter: {nota.md: H2}
    const localAfter: LocalSnapshot = { 'nota.md': H2 };
    expect(planPush(next, localAfter)).toEqual([]);
  });

  it('after applyPullPlan on modified snapshot → planPush includes only the copy with baseHash null', () => {
    const state: SyncState = { cursor: 0, files: { 'Nota.md': { syncedHash: S1 } } };
    const local: LocalSnapshot = { 'Nota.md': L2 };
    const remote = [makeEntry('Nota.md', null, 1), makeEntry('nota.md', H2, 2)];
    const plan = planPull(state, local, remote, { localAuthor: 'joys' });
    const conflictAction = plan.actions.find((a) => a.type === 'conflict') as Extract<
      PullAction,
      { type: 'conflict' }
    >;
    expect(conflictAction).toBeDefined();
    const next = applyPullPlan(state, plan);
    // Local after adapter: {nota.md: H2, [copyPath]: L2}
    const localAfter: LocalSnapshot = { 'nota.md': H2, [conflictAction.copyPath]: L2 };
    const pushes = planPush(next, localAfter);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ path: conflictAction.copyPath, baseHash: null, newHash: L2 });
  });

  it('mixed-order: 4 action kinds in shuffled input → output sorted by (rank, path)', () => {
    // Build a plan directly with shuffled action order
    // rank: conflict=0, delete=1, write/noop=2
    const state: SyncState = {
      cursor: 0,
      files: {
        'c-conflict.md': { syncedHash: A },
        'd-delete.md': { syncedHash: A },
        'n-noop.md': { syncedHash: B },
      },
    };
    const local: LocalSnapshot = {
      'c-conflict.md': B, // locally modified → conflict (L≠S)
      'd-delete.md': A, // unchanged → rule 3 delete (R=null)
      'n-noop.md': C, // R===L=C → noop
      // 'w-write.md' absent → new file
    };
    const remote = [
      makeEntry('n-noop.md', C, 4), // rank 2 (noop)   — shuffled first
      makeEntry('w-write.md', H2, 3), // rank 2 (write)  — shuffled second
      makeEntry('d-delete.md', null, 2), // rank 1 (delete) — shuffled third
      makeEntry('c-conflict.md', C, 1), // rank 0 (conflict)— shuffled last
    ];
    const plan = planPull(state, local, remote, { localAuthor: 'joys' });
    const types = plan.actions.map((a) => a.type);
    const paths = plan.actions.map((a) => a.path);
    // conflict must come before delete, delete before write/noop
    expect(types[0]).toBe('conflict');
    expect(types[1]).toBe('delete');
    // write and noop both have rank 2 — verify sorted by path
    const rank2 = plan.actions.filter((a) => a.type === 'write' || a.type === 'noop');
    const rank2Paths = rank2.map((a) => a.path);
    expect(rank2Paths).toEqual([...rank2Paths].sort());
    // Verify all 4 actions are present
    expect(paths).toContain('c-conflict.md');
    expect(paths).toContain('d-delete.md');
    expect(paths).toContain('w-write.md');
    expect(paths).toContain('n-noop.md');
  });
});

// ─── applyPullPlan — AC8: full conflict cycle ─────────────────────────────────

describe('applyPullPlan — AC8: full conflict cycle → planPush uploads only the copy', () => {
  it('state {a.md:A}, local {a.md:B}, remote a.md→C → conflict → applyPullPlan → planPush === [{copyPath, baseHash:null, newHash:B}]', () => {
    const state: SyncState = { cursor: 0, files: { 'a.md': { syncedHash: A } } };
    const local: LocalSnapshot = { 'a.md': B }; // locally modified
    const remote = [makeEntry('a.md', C)]; // R=C, conflict
    const plan = planPull(state, local, remote, { localAuthor: 'joys' });
    const conflictAction = plan.actions.find((a) => a.type === 'conflict') as Extract<
      PullAction,
      { type: 'conflict' }
    >;
    expect(conflictAction).toBeDefined();
    expect(conflictAction.path).toBe('a.md');
    expect(conflictAction.remoteHash).toBe(C);
    expect(conflictAction.localHash).toBe(B);

    const next = applyPullPlan(state, plan);
    // State after: a.md syncedHash = C; copyPath NOT in state
    expect(next.files['a.md']?.syncedHash).toBe(C);
    expect(conflictAction.copyPath in next.files).toBe(false);

    // After adapter runs: local = {a.md:C, copyPath:B}
    const localAfter: LocalSnapshot = { 'a.md': C, [conflictAction.copyPath]: B };
    const pushes = planPush(next, localAfter);
    // Only the copy should be pushed (baseHash null = new file)
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toMatchObject({ path: conflictAction.copyPath, baseHash: null, newHash: B });
  });
});
