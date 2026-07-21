import { describe, expect, it } from 'vitest';
import { isNonInteractive } from './install-flags.js';

describe('isNonInteractive', () => {
  it('is interactive on a TTY with no opt-out flag', () => {
    expect(isNonInteractive([], true)).toBe(false);
    expect(isNonInteractive(['--force'], true)).toBe(false);
  });

  it('is non-interactive with --yes or --defaults', () => {
    expect(isNonInteractive(['--yes'], true)).toBe(true);
    expect(isNonInteractive(['--defaults'], true)).toBe(true);
    expect(isNonInteractive(['install', '--yes'], true)).toBe(true);
  });

  it('is non-interactive when stdin is not a TTY (CI, pipes)', () => {
    expect(isNonInteractive([], false)).toBe(true);
  });
});
