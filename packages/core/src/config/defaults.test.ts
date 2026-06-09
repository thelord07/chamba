import { describe, expect, it } from 'vitest';
import { getModel } from '../models/catalog.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { AGENT_ROLES } from './roles.js';
import { agentConfigSchema } from './schema.js';

describe('DEFAULT_CONFIG', () => {
  it('defines all seven roles', () => {
    for (const role of AGENT_ROLES) {
      expect(DEFAULT_CONFIG.defaults[role]).toBeDefined();
    }
  });

  it('every default passes the agent-config schema', () => {
    for (const role of AGENT_ROLES) {
      expect(agentConfigSchema.safeParse(DEFAULT_CONFIG.defaults[role]).success).toBe(true);
    }
  });

  it('every default model exists in the catalog', () => {
    for (const role of AGENT_ROLES) {
      expect(getModel(DEFAULT_CONFIG.defaults[role].model)).toBeDefined();
    }
  });

  it('uses the documented reparto for the brain and the cheap roles', () => {
    expect(DEFAULT_CONFIG.defaults.planner).toEqual({
      model: 'claude-opus-4-8',
      effort: 'extreme',
      reasoning_priority: 'thoroughness',
    });
    expect(DEFAULT_CONFIG.defaults.summarizer.model).toBe('claude-haiku-4-5');
  });
});
