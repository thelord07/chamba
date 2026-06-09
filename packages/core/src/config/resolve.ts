import { getModel } from '../models/catalog.js';
import type { AgentRole } from './roles.js';
import type { AgentConfig, ResolvedConfig } from './types.js';

/** The resolved config for one role. */
export function resolveRole(config: ResolvedConfig, role: AgentRole): AgentConfig {
  return config[role];
}

const PRIORITY_PHRASE: Record<AgentConfig['reasoning_priority'], string> = {
  speed: 'optimized for speed on mechanical work',
  balanced: 'balanced between speed and reasoning',
  thoroughness: 'optimized for deep reasoning',
};

/**
 * A short, deterministic (no-LLM) hint the editor's model can read to decide
 * how to delegate this role — e.g. "use a model optimized for deep reasoning;
 * suggested: claude-opus-4-8 with maximum effort."
 */
export function buildHint(role: AgentRole, cfg: AgentConfig): string {
  const model = getModel(cfg.model);
  const effortPhrase = cfg.effort === 'extreme' ? 'maximum' : cfg.effort;
  const advisory =
    model && !model.supports_thinking
      ? ' (this model has no adjustable thinking, so effort is advisory)'
      : '';
  return `For the ${role} role, use a model ${PRIORITY_PHRASE[cfg.reasoning_priority]}; suggested: ${cfg.model} with ${effortPhrase} effort${advisory}.`;
}
