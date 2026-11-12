/**
 * adapters/node-random.ts — RandomPort implementation using the Web Crypto API
 * (`crypto.getRandomValues`), available globally since Node 19.
 */

import type { RandomPort } from '@chamba/core';

/** Node-backed `RandomPort` using `crypto.getRandomValues`. */
export class NodeRandom implements RandomPort {
  hex(n: number): string {
    const bytes = new Uint8Array(Math.ceil(n / 2));
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, n);
  }
}
