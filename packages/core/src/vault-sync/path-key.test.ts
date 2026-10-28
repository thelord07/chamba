import { describe, expect, it } from 'vitest';
import { findCaseCollisions, pathKey } from './path-key.js';

describe('pathKey', () => {
  it('lowercases ASCII paths', () => {
    expect(pathKey('Nota.md')).toBe('nota.md');
    expect(pathKey('UPPER/Lower.md')).toBe('upper/lower.md');
  });

  it('NFC-normalizes: NFD día.md equals NFC día.md', () => {
    // NFD: 'd' + 'i' + combining-acute + 'a' = "dia" with decomposed í
    const nfd = 'día.md';
    // NFC: 'd' + 'í' (precomposed) + 'a' = "día"
    const nfc = 'día.md';
    expect(pathKey(nfd)).toBe(pathKey(nfc));
  });

  it('is idempotent: pathKey(pathKey(x)) === pathKey(x) with NFD Latin input', () => {
    const nfd = 'día.md';
    const once = pathKey(nfd);
    const twice = pathKey(once);
    expect(twice).toBe(once);
  });
});

describe('findCaseCollisions', () => {
  it('AC2 exact: [Nota.md, nota.md, b.md] → [["Nota.md","nota.md"]]', () => {
    expect(findCaseCollisions(['Nota.md', 'nota.md', 'b.md'])).toEqual([['Nota.md', 'nota.md']]);
  });

  it('no collisions → []', () => {
    expect(findCaseCollisions(['a.md', 'b.md', 'c.md'])).toEqual([]);
  });

  it('identical duplicates → [] (deduplication, not a collision)', () => {
    expect(findCaseCollisions(['a.md', 'a.md'])).toEqual([]);
  });

  it('3-way collision: group appears in first-seen order', () => {
    const result = findCaseCollisions(['A.md', 'a.md', 'a.MD']);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(['A.md', 'a.md', 'a.MD']);
  });

  it('multi-group: groups appear in first-seen key order', () => {
    const result = findCaseCollisions(['Nota.md', 'nota.md', 'B.md', 'b.md']);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(['Nota.md', 'nota.md']);
    expect(result[1]).toEqual(['B.md', 'b.md']);
  });
});
