import { describe, expect, it } from 'vitest';
import { getModel } from '../models/catalog.js';
import { isPresetName, PRESET_NAMES, PRESETS, presetConfigFile } from './presets.js';
import { AGENT_ROLES, EFFORT_LEVELS, REASONING_PRIORITIES } from './roles.js';

describe('presets', () => {
  it('every preset defines every role with a catalog model and valid effort/priority', () => {
    for (const name of PRESET_NAMES) {
      const preset = PRESETS[name];
      for (const role of AGENT_ROLES) {
        const cfg = preset[role];
        expect(cfg, `${name}.${role}`).toBeDefined();
        expect(getModel(cfg.model), `${name}.${role} model ${cfg.model}`).toBeDefined();
        expect(EFFORT_LEVELS).toContain(cfg.effort);
        expect(REASONING_PRIORITIES).toContain(cfg.reasoning_priority);
      }
    }
  });

  it('presetConfigFile expands a preset into a full defaults block', () => {
    const file = presetConfigFile('quality');
    expect(file.version).toBe(1);
    expect(Object.keys(file.defaults ?? {}).sort()).toEqual([...AGENT_ROLES].sort());
  });

  it('isPresetName guards unknown names', () => {
    expect(isPresetName('budget')).toBe(true);
    expect(isPresetName('turbo')).toBe(false);
  });

  it('presets are distinct: quality uses opus, budget/fast lean cheap and low', () => {
    expect(PRESETS.quality.planner.model).toContain('opus');
    expect(PRESETS.budget.implementer.model).toContain('haiku');
    expect(PRESETS.fast.orchestrator.effort).toBe('low');
    expect(PRESETS.fast.orchestrator.reasoning_priority).toBe('speed');
  });
});
