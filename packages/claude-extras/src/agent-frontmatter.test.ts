import type { AgentConfig } from '@chamba/core';
import { describe, expect, it } from 'vitest';
import { parseAgentMarkdown, renderAgentMarkdown } from './agent-frontmatter.js';

const ASSET = `---
name: implementer
description: Implements a single, well-scoped subtask
---

You are the **implementer**. Do exactly one subtask.`;

describe('parseAgentMarkdown', () => {
  it('extracts name, description and body', () => {
    const parsed = parseAgentMarkdown(ASSET);
    expect(parsed.name).toBe('implementer');
    expect(parsed.description).toBe('Implements a single, well-scoped subtask');
    expect(parsed.body).toContain('You are the **implementer**');
  });
});

describe('renderAgentMarkdown', () => {
  const anthropic: AgentConfig = {
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    reasoning_priority: 'balanced',
  };

  it('injects an Anthropic model and effort, preserving the body', () => {
    const out = renderAgentMarkdown(parseAgentMarkdown(ASSET), anthropic);
    expect(out).toContain('name: implementer');
    expect(out).toContain('model: claude-sonnet-4-6');
    expect(out).toContain('effort: medium');
    expect(out).toContain('You are the **implementer**');
  });

  it('maps extreme effort to max', () => {
    const out = renderAgentMarkdown(parseAgentMarkdown(ASSET), {
      ...anthropic,
      model: 'claude-opus-4-8',
      effort: 'extreme',
    });
    expect(out).toContain('effort: max');
  });

  it('omits the model line for a non-Anthropic model but keeps effort', () => {
    const out = renderAgentMarkdown(parseAgentMarkdown(ASSET), {
      ...anthropic,
      model: 'gpt-5.5',
    });
    expect(out).not.toContain('model: gpt-5.5');
    expect(out).toContain('not an Anthropic model');
    expect(out).toContain('effort: medium');
  });

  it('produces valid leading frontmatter delimiters', () => {
    const out = renderAgentMarkdown(parseAgentMarkdown(ASSET), anthropic);
    expect(out.startsWith('---\n')).toBe(true);
    expect(out.split('---').length).toBeGreaterThanOrEqual(3);
  });
});
