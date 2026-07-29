import { type AgentRole, getModel } from '@chamba/core';

/** A chamba asset (command or subagent) split into frontmatter + body. */
export interface ParsedAsset {
  /** `name:` from the frontmatter (agents), else ''. */
  name: string;
  /** `description:` from the frontmatter. */
  description: string;
  /** Every parsed frontmatter key. */
  frontmatter: Record<string, string>;
  /** The prompt body, trimmed. */
  body: string;
}

/** Split a chamba `.md` asset into its frontmatter fields and prompt body. */
export function parseAsset(text: string): ParsedAsset {
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta: Record<string, string> = {};
  if (fm?.[1]) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^([\w-]+):\s*(.*)$/);
      if (m?.[1]) meta[m[1]] = (m[2] ?? '').trim();
    }
  }
  const body = fm ? text.slice(fm[0].length) : text;
  return {
    name: meta.name ?? '',
    description: meta.description ?? '',
    frontmatter: meta,
    body: body.trim(),
  };
}

/**
 * Which shipped subagent file maps to which config role. This mirrors
 * `AGENT_ROLE_BY_FILE` in @chamba/claude-extras (the source of truth) — keep the
 * two in sync when a subagent is added or its tier changes.
 */
export const AGENT_ROLE_BY_FILE: Record<string, AgentRole> = {
  'planner.md': 'planner',
  'implementer.md': 'implementer',
  'reviewer.md': 'reviewer',
  'tester.md': 'tester',
  'qa.md': 'qa',
  'diagnostician.md': 'researcher',
};

/**
 * Render a chamba command as an OpenCode command (`.opencode/commands/*.md`):
 * keep `description`, drop the Claude-Code-only `argument-hint`, and pass the body
 * through untouched — `$ARGUMENTS` works the same in OpenCode.
 */
export function renderOpenCodeCommand(parsed: ParsedAsset): string {
  const lines = ['---'];
  if (parsed.description) lines.push(`description: ${parsed.description}`);
  lines.push('---');
  return `${lines.join('\n')}\n\n${parsed.body}\n`;
}

/**
 * Render a chamba subagent as an OpenCode subagent (`.opencode/agents/*.md`):
 * `mode: subagent`, the description, and the model as OpenCode's provider-scoped
 * string (`anthropic/<id>`) when the configured model is Anthropic. For any other
 * provider the model is omitted so OpenCode falls back to its own default — its
 * catalog may not know the bare id, and a wrong pin would silently fail. There is
 * no OpenCode equivalent of chamba's `effort`, so it is dropped.
 */
export function renderOpenCodeAgent(parsed: ParsedAsset, model: string): string {
  const info = getModel(model);
  const lines = ['---', `description: ${parsed.description}`, 'mode: subagent'];
  if (info?.provider === 'anthropic') {
    lines.push(`model: anthropic/${model}`);
  } else if (model) {
    lines.push(`# model '${model}' is not Anthropic; OpenCode uses its configured default`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n\n${parsed.body}\n`;
}
