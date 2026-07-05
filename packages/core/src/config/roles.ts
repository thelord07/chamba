// Agent roles, effort levels and reasoning priorities — the vocabulary the
// per-agent config is built on. Pure data, no Node APIs, no LLM calls.

/** The roles a model can play when the editor delegates work. */
export type AgentRole =
  | 'orchestrator'
  | 'planner'
  | 'reviewer'
  | 'implementer'
  | 'tester'
  | 'qa'
  | 'summarizer'
  | 'researcher';

/** Canonical order — this is also the order the install wizard walks. */
export const AGENT_ROLES: readonly AgentRole[] = [
  'orchestrator',
  'planner',
  'reviewer',
  'implementer',
  'tester',
  'qa',
  'summarizer',
  'researcher',
];

/**
 * Abstract effort level. chamba is multi-editor, so this is a provider-neutral
 * enum; each model in the catalog maps these four levels to its own native
 * vocabulary (Claude Code `effort:`, OpenAI `reasoning_effort`, Gemini
 * `thinkingLevel`, …). `extreme` is the ceiling — e.g. it becomes `max` in
 * Claude Code and `xhigh` in OpenAI.
 */
export type Effort = 'low' | 'medium' | 'high' | 'extreme';

export const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'extreme'];

/** Semantic hint the editor's model can read to decide how to delegate. */
export type ReasoningPriority = 'speed' | 'balanced' | 'thoroughness';

export const REASONING_PRIORITIES: readonly ReasoningPriority[] = [
  'speed',
  'balanced',
  'thoroughness',
];

/** One-line description per role, shown in the wizard and `chamba-config show`. */
export const ROLE_DESCRIPTIONS: Record<AgentRole, string> = {
  orchestrator: 'Decomposes the task, plans, and decides — the brain.',
  planner: 'Produces the detailed plan when the orchestrator delegates planning.',
  reviewer: 'Audits the plan and code with critical judgement.',
  implementer: 'Writes code against a clear, reviewed spec.',
  tester: 'Writes and runs tests over already-implemented code.',
  qa: 'Acceptance QA: exercises the running app and validates acceptance criteria.',
  summarizer: 'Summarizes what happened — mechanical, cheap.',
  researcher: 'Investigates context, reads docs, synthesizes.',
};
