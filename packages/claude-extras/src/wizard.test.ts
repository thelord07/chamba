import { describe, expect, it } from 'vitest';
import { buildConfigFromAnswers, defaultConfigFile, runWizard } from './wizard.js';

describe('buildConfigFromAnswers', () => {
  it('uses the answer for model + effort and derives reasoning_priority from the role', () => {
    const config = buildConfigFromAnswers([
      { role: 'implementer', model: 'claude-haiku-4-5', effort: 'low' },
    ]);
    expect(config.defaults?.implementer).toEqual({
      model: 'claude-haiku-4-5',
      effort: 'low',
      // implementer's default priority is 'balanced' — derived, not asked
      reasoning_priority: 'balanced',
    });
  });

  it('falls back to the compiled default for roles without an answer', () => {
    const config = buildConfigFromAnswers([]);
    expect(config.defaults?.planner?.model).toBe('claude-opus-5');
    expect(config.defaults?.summarizer?.model).toBe('claude-haiku-4-5');
  });
});

describe('runWizard', () => {
  it('returns the full defaults in non-interactive mode without prompting', async () => {
    const config = await runWizard({ nonInteractive: true });
    expect(config).toEqual(defaultConfigFile());
  });
});
