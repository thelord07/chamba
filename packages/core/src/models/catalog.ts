import type { Effort } from '../config/roles.js';

// The single source of truth about which models exist and how chamba's abstract
// `effort` maps to each provider's native vocabulary. chamba never calls these
// models — this is declarative metadata the editor's model consumes.
//
// Re-verify before each release — these are moving targets. Verified at 1.0.0:
// the Anthropic tier (chamba's recommended defaults) is current — Opus 4.8 / 4.7,
// Sonnet 4.6, Haiku 4.5, and Fable 5 (~$10/$50 per 1M, ~2× Opus 4.8, 30-day retention).
// Still unconfirmed, with conservative fallbacks already in place: whether
// `gpt-5.5-mini` accepts `xhigh`, and whether `gemini-3.1-pro-preview` is still the
// current flagship Pro id.

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
  /** Cost note surfaced when the model has adoption caveats (premium tiers). */
  pricing_note?: string;
  /** True if the org must have a data-retention policy the model requires. */
  requires_data_retention?: boolean;
  /** True if safety classifiers may decline some requests (refusal). */
  can_refuse?: boolean;
}

// Claude Code subagent `effort:` accepts low|medium|high|xhigh|max — `extreme` → `max`.
// Note: this path cannot emit `xhigh`. Fable 5's recommended coding/agentic setting is
// `xhigh`, so a Fable 5 role on Claude Code runs at `high` or `max`, never `xhigh`.
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
    // Opt-in, premium — NOT a default. Its recommended `xhigh` setting is not reachable
    // on the Claude Code path (extreme → max skips xhigh), so it runs at high or max.
    id: 'claude-fable-5',
    provider: 'anthropic',
    label: 'Claude Fable 5',
    description:
      "Anthropic's most capable model for demanding long-horizon reasoning. Opt-in, premium.",
    supports_thinking: true,
    effortMap: ANTHROPIC_EFFORT,
    pricing_note: '~$10/$50 per 1M tokens — roughly 2× Opus 4.8 (verify per release).',
    requires_data_retention: true,
    can_refuse: true,
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

/**
 * A one-line adoption caveat for a model (cost, data-retention, refusal), or
 * `undefined` when it has none. Surfaced by the wizard, the config hint and the
 * generated subagent frontmatter so a premium/gated model never fails silently.
 */
export function modelCaveat(model: ModelInfo): string | undefined {
  const parts: string[] = [];
  if (model.pricing_note) parts.push(model.pricing_note);
  if (model.requires_data_retention) {
    parts.push('requires 30-day data retention (zero-retention orgs get a 400 on every request).');
  }
  if (model.can_refuse) parts.push('safety classifiers may decline some requests.');
  return parts.length > 0 ? parts.join(' ') : undefined;
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
