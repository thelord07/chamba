import { describe, expect, it } from 'vitest';
import { parseChambaConfig } from './schema.js';

describe('parseChambaConfig', () => {
  it('accepts a valid full config', () => {
    const result = parseChambaConfig({
      version: 1,
      defaults: {
        implementer: {
          model: 'claude-sonnet-4-6',
          effort: 'medium',
          reasoning_priority: 'balanced',
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts an overrides-only file with a single field', () => {
    const result = parseChambaConfig({
      version: 1,
      overrides: { reviewer: { model: 'claude-sonnet-4-6' } },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown model with a helpful message', () => {
    const result = parseChambaConfig({
      version: 1,
      overrides: { reviewer: { model: 'gpt-9-turbo' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("unknown model 'gpt-9-turbo'");
  });

  it('rejects an invalid effort', () => {
    const result = parseChambaConfig({
      version: 1,
      overrides: { tester: { effort: 'ultra' } },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown role', () => {
    const result = parseChambaConfig({
      version: 1,
      overrides: { wizard: { model: 'claude-opus-4-8' } },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a wrong version', () => {
    const result = parseChambaConfig({ version: 2 });
    expect(result.ok).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    const result = parseChambaConfig({ version: 1, foo: true });
    expect(result.ok).toBe(false);
  });
});
