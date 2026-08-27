import { describe, expect, it } from 'vitest';
import { findOverlaps, partitionByOverlap } from './overlap.js';

describe('findOverlaps', () => {
  it('returns intersecting paths between two items', () => {
    const overlaps = findOverlaps([
      { id: 'a', paths: ['src/auth/login.ts', 'src/app.ts'] },
      { id: 'b', paths: ['src/auth/login.ts', 'src/other.ts'] },
    ]);
    expect(overlaps).toEqual([{ a: 'a', b: 'b', files: ['src/auth/login.ts'] }]);
  });

  it('ignores empty path sets', () => {
    expect(
      findOverlaps([
        { id: 'a', paths: [] },
        { id: 'b', paths: ['x.ts'] },
      ]),
    ).toEqual([]);
  });
});

describe('partitionByOverlap', () => {
  it('packs non-overlapping items into one wave', () => {
    const r = partitionByOverlap([
      { id: 'a', paths: ['src/a.ts'] },
      { id: 'b', paths: ['src/b.ts'] },
    ]);
    expect(r.waves).toEqual([{ ids: ['a', 'b'] }]);
    expect(r.maxWaveSize).toBe(2);
    expect(r.overlaps).toEqual([]);
  });

  it('splits overlapping items across waves', () => {
    const r = partitionByOverlap([
      { id: 'a', paths: ['src/auth.ts'] },
      { id: 'b', paths: ['src/auth.ts'] },
      { id: 'c', paths: ['src/util.ts'] },
    ]);
    expect(r.overlaps).toHaveLength(1);
    expect(r.waves[0]?.ids).toEqual(['a', 'c']);
    expect(r.waves[1]?.ids).toEqual(['b']);
    expect(r.maxWaveSize).toBe(2);
  });
});
