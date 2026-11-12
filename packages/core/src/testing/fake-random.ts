/**
 * testing/fake-random.ts — deterministic `RandomPort` for tests.
 * Exported from @chamba/core for use in tests across packages.
 *
 * Returns a counter-derived hex string per call (never the same twice in a
 * single instance), so tests that assert "two calls → two different nonces"
 * are deterministic without depending on real randomness.
 */

import type { RandomPort } from '../ports/random.js';

export class FakeRandom implements RandomPort {
  private counter = 0;

  hex(n: number): string {
    const value = (this.counter++).toString(16).padStart(n, '0');
    return value.slice(-n);
  }
}
