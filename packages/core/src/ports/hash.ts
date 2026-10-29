/**
 * ports/hash.ts — Hash port for @chamba/core.
 * Pure: no Node imports. Node implementation uses node:crypto; fake uses Web Crypto.
 */

/**
 * Hash port. Async to support both Web Crypto (fake/browser) and node:crypto.
 */
export interface HashPort {
  /** Compute SHA-256 of `data` and return as lowercase hex string (64 chars). */
  sha256(data: Uint8Array): Promise<string>;
}
