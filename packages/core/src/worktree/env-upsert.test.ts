import { describe, expect, it } from 'vitest';
import { readEnvVar, upsertEnvVar } from './env-upsert.js';

describe('upsertEnvVar', () => {
  it('appends the key when missing', () => {
    expect(upsertEnvVar('FOO=1\n', 'PORT', '3010')).toBe('FOO=1\nPORT=3010\n');
  });

  it('replaces an existing key without touching other lines', () => {
    expect(upsertEnvVar('PORT=3000\nFOO=1\n', 'PORT', '3010')).toBe('PORT=3010\nFOO=1\n');
  });

  it('is idempotent when the value is already set', () => {
    const s = 'PORT=3010\n';
    expect(upsertEnvVar(s, 'PORT', '3010')).toBe(s);
  });
});

describe('readEnvVar', () => {
  it('returns the value or undefined', () => {
    expect(readEnvVar('PORT=3010\n', 'PORT')).toBe('3010');
    expect(readEnvVar('FOO=1\n', 'PORT')).toBeUndefined();
  });
});
