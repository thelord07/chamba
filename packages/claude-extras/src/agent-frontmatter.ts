import { type AgentConfig, type AgentRole, type Effort, getModel } from '@chamba/core';

/**
 * Which shipped subagent asset file maps to which config role. These four
 * subagents exist as files; the remaining roles (orchestrator, summarizer,
 * researcher) are reachable via `chamba_get_agent_config` and the `chamba-config`
 * CLI, not as `~/.claude/agents/*.md`. The orchestrator is the main session.
 */
export const AGENT_ROLE_BY_FILE: Record<string, AgentRole> = {
  'planner.md': 'planner',
  'implementer.md': 'implementer',
  'reviewer.md': 'reviewer',
  'tester.md': 'tester',
};

/**
 * The subagent frontmatter is always consumed by Claude Code, which always runs
 * an Anthropic model — so effort is emitted in Claude Code's vocabulary
 * (low|medium|high|xhigh|max), with chamba's abstract `extreme` becoming `max`.
 */
const CLAUDE_CODE_EFFORT: Record<Effort, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  extreme: 'max',
};

export interface ParsedAgent {
  name: string;
  description: string;
  body: string;
}

/** Split a subagent asset file into its name, description and prompt body. */
export function parseAgentMarkdown(text: string): ParsedAgent {
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta: Record<string, string> = {};
  if (fm?.[1]) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m?.[1]) meta[m[1]] = (m[2] ?? '').trim();
    }
  }
  const body = fm ? text.slice(fm[0].length) : text;
  return {
    name: meta.name ?? '',
    description: meta.description ?? '',
    body: body.trim(),
  };
}

/**
 * Render a subagent `.md` with `model` + `effort` injected from the config.
 * If the configured model is not an Anthropic model, Claude Code cannot run it,
 * so `model:` is omitted (the subagent inherits the session model) and a comment
 * records why. `effort` is always emitted in Claude Code vocabulary.
 */
export function renderAgentMarkdown(parsed: ParsedAgent, cfg: AgentConfig): string {
  const model = getModel(cfg.model);
  const isAnthropic = model?.provider === 'anthropic';
  const effort = CLAUDE_CODE_EFFORT[cfg.effort];

  const lines = ['---', `name: ${parsed.name}`, `description: ${parsed.description}`];
  if (isAnthropic) {
    lines.push(`model: ${cfg.model}`);
  } else {
    lines.push(
      `# requested model '${cfg.model}' is not an Anthropic model; Claude Code uses the session model (inherit)`,
    );
  }
  lines.push(`effort: ${effort}`, '---');

  return `${lines.join('\n')}\n\n${parsed.body}\n`;
}
