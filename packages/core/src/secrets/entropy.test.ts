import { describe, expect, it } from 'vitest';
import {
  isPlaceholder,
  looksLikeProseWords,
  REDACTED_PLACEHOLDER,
  shannonEntropy,
} from './entropy.js';

describe('shannonEntropy', () => {
  it('is 0 for an empty string', () => {
    expect(shannonEntropy('')).toBe(0);
  });

  it('is 0 for a single repeated character', () => {
    expect(shannonEntropy('aaaaaaaaaa')).toBe(0);
  });

  it('is higher for a high-entropy random-looking string than a low-entropy one', () => {
    const low = 'aaaaaaaaaaaaaaaaaaaaaaaa';
    const high = `${'K7'}${'pQ2vT9mZ1xR4wL8n'}${'B3'}`; // concatenated, random-shaped
    expect(shannonEntropy(high)).toBeGreaterThan(shannonEntropy(low));
    expect(shannonEntropy(high)).toBeGreaterThanOrEqual(3.5);
  });
});

describe('isPlaceholder', () => {
  const placeholders = [
    REDACTED_PLACEHOLDER,
    '<tu-token>',
    '<your-token-here>',
    'xxxxxxxxxx',
    'XXXXXXXX',
    '***',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder syntax, not a template literal
    '${DATABASE_URL}',
    'process.env.OPENAI_API_KEY',
    'changeme',
    'your-key-here',
  ];

  for (const p of placeholders) {
    it(`treats "${p}" as a placeholder`, () => {
      expect(isPlaceholder(p)).toBe(true);
    });
  }

  it('does not treat a 64-hex blob hash as a placeholder', () => {
    const hex64 = 'a1b2c3d4e5f6'.repeat(5).slice(0, 64);
    expect(isPlaceholder(hex64)).toBe(false);
  });

  it('does not treat a realistic-looking token value as a placeholder', () => {
    const value = `${'Kx7'}${'pQ2vT9mZ1xR4wL8nC6dF'}`;
    expect(isPlaceholder(value)).toBe(false);
  });

  it('treats an empty string as a placeholder', () => {
    expect(isPlaceholder('')).toBe(true);
  });
});

describe('looksLikeProseWords', () => {
  const prose = [
    'no-expiration-by-default',
    'always-use-https-in-production',
    'do-not-commit-this-file',
  ];

  for (const p of prose) {
    it(`treats "${p}" as prose, not a secret`, () => {
      expect(looksLikeProseWords(p)).toBe(true);
    });
  }

  it('does not treat a single word without hyphens as prose (too broad otherwise)', () => {
    expect(looksLikeProseWords('changeme')).toBe(false);
  });

  it('does not treat a realistic token (mixed case / digits) as prose', () => {
    expect(looksLikeProseWords('Kx7pQ2vT9mZ1xR4wL8nC6dF')).toBe(false);
    expect(looksLikeProseWords('abc123-def456-ghi789')).toBe(false);
  });
});
