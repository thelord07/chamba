import type { AgentRole } from './roles.js';
import type { ConfigFile } from './schema.js';
import type { AgentConfig } from './types.js';

/**
 * Named model+effort bundles that set every role at once, layered on top of the
 * per-role config. A quick cost/quality dial: `config preset budget|balanced|
 * quality|fast`. Applying a preset writes its full `defaults` block — portable,
 * no new schema surface. chamba still never calls a model; this only tells the
 * editor's model how to delegate.
 */
export type PresetName = 'budget' | 'balanced' | 'quality' | 'fast';

export const PRESET_NAMES: readonly PresetName[] = ['budget', 'balanced', 'quality', 'fast'];

export const PRESET_DESCRIPTIONS: Record<PresetName, string> = {
  budget: 'Lowest cost — cheap models everywhere, enough reasoning to stay usable.',
  balanced: 'Mid-range — Sonnet across the board, more effort on the reasoning roles.',
  quality: 'Maximum reasoning — Opus for the brain (the recommended defaults).',
  fast: 'Lowest latency — fast models, low effort, speed-first on every role.',
};

const OPUS = 'claude-opus-4-8';
const OPUS_PREV = 'claude-opus-4-7';
const SONNET = 'claude-sonnet-4-6';
const HAIKU = 'claude-haiku-4-5';

/** Full role→config map for each preset. Every preset covers all `AGENT_ROLES`. */
export const PRESETS: Record<PresetName, Record<AgentRole, AgentConfig>> = {
  budget: {
    orchestrator: { model: SONNET, effort: 'medium', reasoning_priority: 'balanced' },
    planner: { model: SONNET, effort: 'medium', reasoning_priority: 'thoroughness' },
    reviewer: { model: SONNET, effort: 'medium', reasoning_priority: 'balanced' },
    implementer: { model: HAIKU, effort: 'low', reasoning_priority: 'speed' },
    tester: { model: HAIKU, effort: 'low', reasoning_priority: 'speed' },
    qa: { model: SONNET, effort: 'medium', reasoning_priority: 'balanced' },
    summarizer: { model: HAIKU, effort: 'low', reasoning_priority: 'speed' },
    researcher: { model: SONNET, effort: 'medium', reasoning_priority: 'balanced' },
  },
  balanced: {
    orchestrator: { model: SONNET, effort: 'high', reasoning_priority: 'thoroughness' },
    planner: { model: SONNET, effort: 'high', reasoning_priority: 'thoroughness' },
    reviewer: { model: SONNET, effort: 'high', reasoning_priority: 'thoroughness' },
    implementer: { model: SONNET, effort: 'medium', reasoning_priority: 'balanced' },
    tester: { model: SONNET, effort: 'medium', reasoning_priority: 'balanced' },
    qa: { model: SONNET, effort: 'high', reasoning_priority: 'thoroughness' },
    summarizer: { model: HAIKU, effort: 'low', reasoning_priority: 'speed' },
    researcher: { model: SONNET, effort: 'high', reasoning_priority: 'balanced' },
  },
  quality: {
    orchestrator: { model: OPUS, effort: 'high', reasoning_priority: 'thoroughness' },
    planner: { model: OPUS, effort: 'extreme', reasoning_priority: 'thoroughness' },
    reviewer: { model: OPUS_PREV, effort: 'high', reasoning_priority: 'thoroughness' },
    implementer: { model: SONNET, effort: 'medium', reasoning_priority: 'balanced' },
    tester: { model: SONNET, effort: 'medium', reasoning_priority: 'balanced' },
    qa: { model: OPUS_PREV, effort: 'high', reasoning_priority: 'thoroughness' },
    summarizer: { model: HAIKU, effort: 'low', reasoning_priority: 'speed' },
    researcher: { model: OPUS_PREV, effort: 'high', reasoning_priority: 'thoroughness' },
  },
  fast: {
    orchestrator: { model: SONNET, effort: 'low', reasoning_priority: 'speed' },
    planner: { model: SONNET, effort: 'low', reasoning_priority: 'speed' },
    reviewer: { model: SONNET, effort: 'low', reasoning_priority: 'speed' },
    implementer: { model: HAIKU, effort: 'low', reasoning_priority: 'speed' },
    tester: { model: HAIKU, effort: 'low', reasoning_priority: 'speed' },
    qa: { model: SONNET, effort: 'low', reasoning_priority: 'speed' },
    summarizer: { model: HAIKU, effort: 'low', reasoning_priority: 'speed' },
    researcher: { model: SONNET, effort: 'low', reasoning_priority: 'speed' },
  },
};

export function isPresetName(value: string): value is PresetName {
  return (PRESET_NAMES as readonly string[]).includes(value);
}

/** The preset expanded into an on-disk config file (full `defaults` block). */
export function presetConfigFile(name: PresetName): ConfigFile {
  return { version: 1, defaults: PRESETS[name] };
}
