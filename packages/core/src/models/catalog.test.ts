import { describe, expect, it } from 'vitest';
import { EFFORT_LEVELS } from '../config/roles.js';
import {
  getModel,
  MODEL_CATALOG,
  type ModelInfo,
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

  it('looks up by id and by provider', () => {
    expect(getModel('claude-haiku-4-5')?.provider).toBe('anthropic');
    expect(getModel('nope')).toBeUndefined();
    expect(modelsByProvider('ollama').length).toBeGreaterThanOrEqual(3);
    expect(modelsByProvider('anthropic').every((m) => m.provider === 'anthropic')).toBe(true);
  });
});
