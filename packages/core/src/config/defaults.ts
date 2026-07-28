import type { ChambaConfig } from './types.js';

/**
 * The compiled, hardcoded defaults — the single source of truth for the
 * recommended reparto of models per role. The philosophy: critical reasoning
 * gets powerful models, mechanical execution gets fast/cheap ones. Users
 * override these via `~/.chamba/config.json`; they are never written to disk
 * unless the user runs the wizard or `chamba-config`.
 */
export const DEFAULT_CONFIG: ChambaConfig = {
  version: 1,
  defaults: {
    // The brain: decomposes and decides. Opus 5 = near-Fable quality at Opus price.
    orchestrator: { model: 'claude-opus-5', effort: 'high', reasoning_priority: 'thoroughness' },
    // Planning delegated: Opus 5 at `high` — the token-savings sweet spot (Opus 5's own
    // default), not `extreme`. Bump to the `quality` preset when you want max reasoning.
    planner: { model: 'claude-opus-5', effort: 'high', reasoning_priority: 'thoroughness' },
    // Critical audit; deep reasoning on the strongest Opus at the same price as before.
    reviewer: { model: 'claude-opus-5', effort: 'high', reasoning_priority: 'thoroughness' },
    // Executes clear specs; Sonnet 5 is faster + cheaper (intro $2/$10) and stronger than 4.6.
    implementer: { model: 'claude-sonnet-5', effort: 'medium', reasoning_priority: 'balanced' },
    // Tests over already-implemented code; same profile as the implementer.
    tester: { model: 'claude-sonnet-5', effort: 'medium', reasoning_priority: 'balanced' },
    // Acceptance QA: reasons about criteria and drives the running app. Capable model.
    qa: { model: 'claude-opus-5', effort: 'high', reasoning_priority: 'thoroughness' },
    // Summaries are mechanical; a fast, cheap model is perfect.
    summarizer: { model: 'claude-haiku-4-5', effort: 'low', reasoning_priority: 'speed' },
    // Research + synthesis (also the /triage diagnostician); high reasoning on Opus 5.
    researcher: { model: 'claude-opus-5', effort: 'high', reasoning_priority: 'thoroughness' },
  },
};
