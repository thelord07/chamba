import { describe, expect, it } from 'vitest';
import { EFFORT_LEVELS } from '../config/roles.js';
import {
  getModel,
  MODEL_CATALOG,
  type ModelInfo,
  modelCaveat,
  modelsByProvider,
  resolveEffort,
} from './catalog.js';

function mustGet(id: string): ModelInfo {
  const model = getModel(id);
  if (!model) throw new Error(`expected model ${id} in catalog`);
  return model;
}

describe('model catalog', () => {
  it('has unique ids', () => {
    const ids = MODEL_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('maps every effort level for every model', () => {
    for (const model of MODEL_CATALOG) {
      for (const effort of EFFORT_LEVELS) {
        expect(model.effortMap).toHaveProperty(effort);
      }
    }
  });

  it('maps extreme to max for Anthropic and xhigh for OpenAI', () => {
    expect(resolveEffort(mustGet('claude-opus-4-8'), 'extreme')).toBe('max');
    expect(resolveEffort(mustGet('gpt-5.5'), 'extreme')).toBe('xhigh');
  });

  it('returns null effort for Ollama models', () => {
    expect(resolveEffort(mustGet('deepseek-r1:7b'), 'high')).toBeNull();
  });

  it('exposes Fable 5 as an opt-in premium model, not the default', () => {
    // Opus 5 is first so it's the visual/default entry (the recommended reasoning model).
    expect(MODEL_CATALOG[0]?.id).toBe('claude-opus-5');
    const fable = mustGet('claude-fable-5');
    expect(fable.provider).toBe('anthropic');
    expect(fable.requires_data_retention).toBe(true);
    // Reuses ANTHROPIC_EFFORT, so extreme still maps to max (never xhigh here).
    expect(resolveEffort(fable, 'extreme')).toBe('max');
  });

  it('reports adoption caveats only for gated models', () => {
    const caveat = modelCaveat(mustGet('claude-fable-5'));
    expect(caveat).toContain('data retention');
    expect(modelCaveat(mustGet('claude-opus-4-8'))).toBeUndefined();
  });

  it('looks up by id and by provider', () => {
    expect(getModel('claude-haiku-4-5')?.provider).toBe('anthropic');
    expect(getModel('nope')).toBeUndefined();
    expect(modelsByProvider('ollama').length).toBeGreaterThanOrEqual(3);
    expect(modelsByProvider('anthropic').every((m) => m.provider === 'anthropic')).toBe(true);
  });
});
