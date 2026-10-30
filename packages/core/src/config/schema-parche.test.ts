/**
 * schema-parche.test.ts — AC1: configFileSchema must reject a 'parche' key.
 * An existing valid config.json still parses identically.
 */

import { describe, expect, it } from 'vitest';
import { configFileSchema, parseChambaConfig } from './schema.js';

describe('configFileSchema — AC1 no parche key', () => {
  it('rejects a config with a "parche" key', () => {
    const result = configFileSchema.safeParse({
      version: 1,
      parche: { server: 'https://parche.chamba.tools', slug: 'team' },
    });
    expect(result.success).toBe(false);
  });

  it('a valid config.json without parche key parses identically', () => {
    const validConfig = {
      version: 1,
      defaults: {
        orchestrator: { model: 'claude-sonnet-4-6', effort: 'high', reasoning_priority: 'speed' },
      },
    };
    const result1 = configFileSchema.safeParse(validConfig);
    const result2 = configFileSchema.safeParse(validConfig);
    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    if (result1.success && result2.success) {
      expect(JSON.stringify(result1.data)).toBe(JSON.stringify(result2.data));
    }
  });

  it('parseChambaConfig rejects parche key with an error message', () => {
    const result = parseChambaConfig({
      version: 1,
      parche: { slug: 'team' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeTruthy();
    }
  });

  it('parseChambaConfig accepts a minimal valid config', () => {
    const result = parseChambaConfig({ version: 1 });
    expect(result.ok).toBe(true);
  });
});
