import { describe, expect, it } from 'vitest';
import { isStale } from './inspector.js';

const now = new Date('2026-08-26T12:00:00Z');
const day = 24 * 60 * 60 * 1000;

describe('isStale', () => {
  it('is false for the primary checkout even if the last commit is old', () => {
    expect(
      isStale({
        primary: true,
        dirty: false,
        ahead: 3,
        lastCommitAt: '2026-01-01T00:00:00Z',
        now,
        staleAfterMs: day,
      }),
    ).toBe(false);
  });

  it('is false when the worktree has no unique commits (fresh fork)', () => {
    expect(
      isStale({
        primary: false,
        dirty: false,
        ahead: 0,
        lastCommitAt: '2026-01-01T00:00:00Z',
        now,
        staleAfterMs: day,
      }),
    ).toBe(false);
  });

  it('is false when the tree is dirty', () => {
    expect(
      isStale({
        primary: false,
        dirty: true,
        ahead: 2,
        lastCommitAt: '2026-01-01T00:00:00Z',
        now,
        staleAfterMs: day,
      }),
    ).toBe(false);
  });

  it('is true when ahead, clean, and last unique work is older than the window', () => {
    expect(
      isStale({
        primary: false,
        dirty: false,
        ahead: 2,
        lastCommitAt: '2026-08-20T12:00:00Z',
        now,
        staleAfterMs: day,
      }),
    ).toBe(true);
  });
});
