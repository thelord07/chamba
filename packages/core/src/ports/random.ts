/**
 * ports/random.ts — Random port for @chamba/core.
 * Pure: no Node imports. Used by CHAMBA-021 S15 to generate a per-call nonce
 * for `wrapVaultData`'s delimiter, so vault content can never guess it and
 * close the data block early.
 */

/** Random port. Synchronous — nonce generation never needs to be awaited. */
export interface RandomPort {
  /** Return `n` random lowercase hex characters (not bytes). */
  hex(n: number): string;
}
