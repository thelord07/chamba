import type { Effort } from '../config/roles.js';

// The single source of truth about which models exist and how chamba's abstract
// `effort` maps to each provider's native vocabulary. chamba never calls these
// models — this is declarative metadata the editor's model consumes.
//
// TODO(catalog): these are moving targets — re-verify before each release.
// In particular: whether `gpt-5.5-mini` accepts `xhigh`, and whether
// `gemini-3.1-pro-preview` is still the current flagship Pro id.

export type ModelProvider = 'anthropic' | 'openai' | 'google' | 'ollama';

export interface ModelInfo {
  /** The exact id used by the provider / editor (e.g. `claude-opus-4-8`). */
  id: string;
  provider: ModelProvider;
  /** Human label for the wizard. */
  label: string;
  /** One-line description for the wizard. */
  description: string;
  /** Whether the model has an adjustable thinking/reasoning budget. */
  supports_thinking: boolean;
  /**
   * Maps chamba's abstract effort to the provider's native value, or `null`
   * when the provider has no effort knob (effort is then advisory only).
   */
  effortMap: Record<Effort, string | null>;
}

// Claude Code subagent `effort:` accepts low|medium|high|xhigh|max — `extreme` → `max`.
const ANTHROPIC_EFFORT: Record<Effort, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  extreme: 'max',
};

// OpenAI `reasoning_effort` accepts none|low|medium|high|xhigh — `extreme` → `xhigh`.
const OPENAI_EFFORT: Record<Effort, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  extreme: 'xhigh',
};

// Gemini has no level above `high`, so `extreme` collapses to `high`.
const GEMINI_FLASH_EFFORT: Record<Effort, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  extreme: 'high',
};

// Gemini 3.x Pro only exposes low|high; `medium` rounds up to `high`.
const GEMINI_PRO_EFFORT: Record<Effort, string> = {
  low: 'low',
  medium: 'high',
  high: 'high',
  extreme: 'high',
};

// Ollama has no provider-level effort enum; thinking is a property of the model.
const NO_EFFORT: Record<Effort, string | null> = {
  low: null,
  medium: null,
  high: null,
  extreme: null,
};

export const MODEL_CATALOG: readonly ModelInfo[] = [
  {
    id: 'claude-opus-4-8',
    provider: 'anthropic',
    label: 'Claude Opus 4.8',
    description: 'Flagship reasoning. Best for critical decomposition and planning.',
    supports_thinking: true,
    effortMap: ANTHROPIC_EFFORT,
  },
  {
    id: 'claude-opus-4-7',
    provider: 'anthropic',
    label: 'Claude Opus 4.7',
    description: 'Previous-gen reasoning, still strong. Good for review and research.',
    supports_thinking: true,
    effortMap: ANTHROPIC_EFFORT,
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    label: 'Claude Sonnet 4.6',
    description: 'Balanced and fast. Ideal for implementation against clear specs.',
    supports_thinking: true,
    effortMap: ANTHROPIC_EFFORT,
  },
  {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    label: 'Claude Haiku 4.5',
    description: 'Cheapest and fastest. Perfect for mechanical work like summaries.',
    supports_thinking: true,
    effortMap: ANTHROPIC_EFFORT,
  },
  {
    id: 'gpt-5.5',
    provider: 'openai',
    label: 'GPT-5.5',
    description: 'OpenAI flagship reasoning model.',
    supports_thinking: true,
    effortMap: OPENAI_EFFORT,
  },
  {
    id: 'gpt-5.5-mini',
    provider: 'openai',
    label: 'GPT-5.5 mini',
    description: 'Smaller, faster OpenAI model for execution.',
    supports_thinking: true,
    // `xhigh` is unconfirmed for the mini; cap `extreme` at `high` to be safe.
    effortMap: { low: 'low', medium: 'medium', high: 'high', extreme: 'high' },
  },
  {
    id: 'gemini-3.1-pro-preview',
    provider: 'google',
    label: 'Gemini 3.1 Pro (preview)',
    description: 'Google flagship reasoning model. thinkingLevel: low | high.',
    supports_thinking: true,
    effortMap: GEMINI_PRO_EFFORT,
  },
  {
    id: 'gemini-3.5-flash',
    provider: 'google',
    label: 'Gemini 3.5 Flash',
    description: 'Fast, cheap, GA. thinkingLevel: minimal | low | medium | high.',
    supports_thinking: true,
    effortMap: GEMINI_FLASH_EFFORT,
  },
  {
    id: 'qwen2.5-coder:7b',
    provider: 'ollama',
    label: 'Qwen2.5 Coder 7B (Ollama)',
    description: 'Local coding model via Ollama. No adjustable thinking.',
    supports_thinking: false,
    effortMap: NO_EFFORT,
  },
  {
    id: 'deepseek-r1:7b',
    provider: 'ollama',
    label: 'DeepSeek-R1 7B (Ollama)',
    description: 'Local reasoning model via Ollama. Thinks natively (always on).',
    supports_thinking: true,
    effortMap: NO_EFFORT,
  },
  {
    id: 'llama3.1:8b',
    provider: 'ollama',
    label: 'Llama 3.1 8B (Ollama)',
    description: 'General-purpose local model via Ollama.',
    supports_thinking: false,
    effortMap: NO_EFFORT,
  },
];

/** Look up a model by exact id. */
export function getModel(id: string): ModelInfo | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

/** All models for a given provider. */
export function modelsByProvider(provider: ModelProvider): ModelInfo[] {
  return MODEL_CATALOG.filter((m) => m.provider === provider);
}

/**
 * Translate chamba's abstract effort to the model's native value. Returns
 * `null` when the provider has no effort knob (effort is advisory).
 */
export function resolveEffort(model: ModelInfo, effort: Effort): string | null {
  return model.effortMap[effort];
}
