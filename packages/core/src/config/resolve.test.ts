import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from './defaults.js';
import { buildHint, resolveRole } from './resolve.js';
import type { ResolvedConfig } from './types.js';

const resolved = DEFAULT_CONFIG.defaults as ResolvedConfig;

describe('resolveRole', () => {
  it('returns the config for a role', () => {
    expect(resolveRole(resolved, 'planner').effort).toBe('high');
    expect(resolveRole(resolved, 'planner').model).toBe('claude-opus-5');
  });
});

describe('buildHint', () => {
  it('mentions the model, the role and maps extreme to maximum', () => {
    // Use an explicit `extreme` config (no default role runs at extreme anymore).
    const hint = buildHint('planner', {
      model: 'claude-opus-5',
      effort: 'extreme',
      reasoning_priority: 'thoroughness',
    });
    expect(hint).toContain('planner');
    expect(hint).toContain('claude-opus-5');
    expect(hint).toContain('maximum effort');
    expect(hint).toContain('deep reasoning');
  });

  it('flags that effort is advisory for models without adjustable thinking', () => {
    const hint = buildHint('implementer', {
      model: 'qwen2.5-coder:7b',
      effort: 'high',
      reasoning_priority: 'balanced',
    });
    expect(hint).toContain('advisory');
  });

  it('describes the speed priority for cheap roles', () => {
    expect(buildHint('summarizer', resolved.summarizer)).toContain('speed');
  });
});
