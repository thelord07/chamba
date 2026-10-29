/**
 * testing/fake-hash.ts — HashPort implementation using Web Crypto (no node:).
 * Exported from @chamba/core for use in tests across packages.
 */

import type { HashPort } from '../ports/hash.js';

/**
 * `HashPort` implementation that uses `globalThis.crypto.subtle.digest`.
 * Works in Node 22+ (where `globalThis.crypto` is the Web Crypto API),
 * in browsers, and in Vitest (which also exposes Web Crypto).
 */
export class FakeHash implements HashPort {
  async sha256(data: Uint8Array): Promise<string> {
    const buffer = await globalThis.crypto.subtle.digest('SHA-256', data.buffer as ArrayBuffer);
    return Array.from(new Uint8Array(buffer))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
}
