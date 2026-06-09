import type { AgentRole, Effort, ReasoningPriority } from './roles.js';

/** What model + effort to use for one role. */
export interface AgentConfig {
  /** A model id from the catalog (e.g. `claude-opus-4-8`). */
  model: string;
  effort: Effort;
  reasoning_priority: ReasoningPriority;
}

/**
 * The in-memory config. `defaults` always has all seven roles fully populated
 * (the compiled `DEFAULT_CONFIG` provides them); `overrides` is an optional,
 * partial set of per-role, per-field tweaks layered on top.
 */
export interface ChambaConfig {
  version: 1;
  defaults: Record<AgentRole, AgentConfig>;
  overrides?: Partial<Record<AgentRole, Partial<AgentConfig>>>;
}

/** A fully-resolved config: every role present, every field filled. */
export type ResolvedConfig = Record<AgentRole, AgentConfig>;
