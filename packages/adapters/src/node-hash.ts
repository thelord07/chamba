/**
 * adapters/node-hash.ts — HashPort implementation using node:crypto.
 */

import { createHash } from 'node:crypto';
import type { HashPort } from '@chamba/core';

/** Node-backed `HashPort` using `node:crypto`. */
export class NodeHash implements HashPort {
  sha256(data: Uint8Array): Promise<string> {
    const hex = createHash('sha256').update(data).digest('hex');
    return Promise.resolve(hex);
  }
}
