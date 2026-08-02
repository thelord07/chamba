import { type AgentRole, getModel } from '@chamba/core';

/** A chamba asset (command or subagent) split into frontmatter + body. */
export interface ParsedAsset {
  name: string;
  description: string;
  frontmatter: Record<string, string>;
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
 * Which shipped subagent file maps to which config role. Mirrors
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
 * Render a chamba command as a Cursor command (`~/.cursor/commands/*.md`).
 * Cursor commands are **plain markdown with no frontmatter** — the file body is
 * the prompt and the filename is the command name — so we drop the frontmatter
 * (description / argument-hint) and emit the body. `$ARGUMENTS` is kept: the user
 * types their request when invoking the command.
 */
export function renderCursorCommand(parsed: ParsedAsset): string {
  return `${parsed.body}\n`;
}

/**
 * Render a chamba subagent as a Cursor subagent (`~/.cursor/agents/*.md`, Cursor
 * 2.4+): `name`, `description`, and `model`. Cursor accepts a bare Anthropic model
 * id (e.g. `claude-opus-5`), so the configured model from your reparto is passed
 * through when it's Anthropic; otherwise `inherit` lets Cursor use the parent
 * agent's model. chamba's `effort` has no stable Cursor equivalent, so it's dropped.
 */
export function renderCursorAgent(parsed: ParsedAsset, model: string): string {
  const info = getModel(model);
  const modelValue = info?.provider === 'anthropic' ? model : 'inherit';
  const lines = [
    '---',
    `name: ${parsed.name}`,
    `description: ${parsed.description}`,
    `model: ${modelValue}`,
    '---',
  ];
  return `${lines.join('\n')}\n\n${parsed.body}\n`;
}
