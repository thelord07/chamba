/**
 * node-hash.test.ts — verify NodeHash matches FakeHash on the same bytes
 * and produces the correct output for a known SHA-256 vector.
 */

import { FakeHash } from '@chamba/core';
import { describe, expect, it } from 'vitest';
import { NodeHash } from './node-hash.js';

// sha256("hello") — known vector from RFC / standard test suites
const HELLO_BYTES = new TextEncoder().encode('hello');
const HELLO_SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

describe('NodeHash', () => {
  it('matches FakeHash on the same bytes', async () => {
    const nodeHash = new NodeHash();
    const fakeHash = new FakeHash();
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const [nodeResult, fakeResult] = await Promise.all([
      nodeHash.sha256(bytes),
      fakeHash.sha256(bytes),
    ]);
    expect(nodeResult).toBe(fakeResult);
  });

  it('produces the correct SHA-256 hex for "hello"', async () => {
    const nodeHash = new NodeHash();
    const result = await nodeHash.sha256(HELLO_BYTES);
    expect(result).toBe(HELLO_SHA256);
  });

  it('returns lowercase hex of length 64', async () => {
    const nodeHash = new NodeHash();
    const result = await nodeHash.sha256(new Uint8Array(32));
    expect(result).toHaveLength(64);
    expect(result).toMatch(/^[0-9a-f]+$/);
  });
});
