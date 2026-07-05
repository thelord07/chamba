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
    // The brain: decomposes and decides. Worth the tokens.
    orchestrator: { model: 'claude-opus-4-8', effort: 'high', reasoning_priority: 'thoroughness' },
    // Max reasoning when planning is delegated; invoked rarely, so it's cheap overall.
    planner: { model: 'claude-opus-4-8', effort: 'extreme', reasoning_priority: 'thoroughness' },
    // Critical audit; deep reasoning but doesn't need the very latest model.
    reviewer: { model: 'claude-opus-4-7', effort: 'high', reasoning_priority: 'thoroughness' },
    // Executes clear specs; speed matters, medium reasoning is enough.
    implementer: { model: 'claude-sonnet-4-6', effort: 'medium', reasoning_priority: 'balanced' },
    // Tests over already-implemented code; same profile as the implementer.
    tester: { model: 'claude-sonnet-4-6', effort: 'medium', reasoning_priority: 'balanced' },
    // Acceptance QA: reasons about criteria and drives the running app. Capable model.
    qa: { model: 'claude-opus-4-7', effort: 'high', reasoning_priority: 'thoroughness' },
    // Summaries are mechanical; a fast, cheap model is perfect.
    summarizer: { model: 'claude-haiku-4-5', effort: 'low', reasoning_priority: 'speed' },
    // Research and synthesis; high reasoning, but doesn't need Opus 4.8.
    researcher: { model: 'claude-opus-4-7', effort: 'high', reasoning_priority: 'thoroughness' },
  },
};
