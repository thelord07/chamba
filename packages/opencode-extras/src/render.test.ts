import { describe, expect, it } from 'vitest';
import { parseAsset, renderOpenCodeAgent, renderOpenCodeCommand } from './render.js';

describe('parseAsset', () => {
  it('splits frontmatter fields from the body', () => {
    const p = parseAsset(
      '---\nname: planner\ndescription: Plans the work\n---\nYou are the planner.\n',
    );
    expect(p.name).toBe('planner');
    expect(p.description).toBe('Plans the work');
    expect(p.body).toBe('You are the planner.');
  });

  it('handles an asset with no frontmatter', () => {
    const p = parseAsset('Just a body.\n');
    expect(p.name).toBe('');
    expect(p.body).toBe('Just a body.');
  });
});

describe('renderOpenCodeCommand', () => {
  it('keeps description, drops argument-hint, preserves the body + $ARGUMENTS', () => {
    const out = renderOpenCodeCommand(
      parseAsset(
        '---\ndescription: Orchestrate a task\nargument-hint: "<task>"\n---\nDo $ARGUMENTS.\n',
      ),
    );
    expect(out).toContain('description: Orchestrate a task');
    expect(out).not.toContain('argument-hint');
    expect(out).toContain('Do $ARGUMENTS.');
  });
});

describe('renderOpenCodeAgent', () => {
  it('emits mode: subagent + a provider-scoped Anthropic model, no effort', () => {
    const out = renderOpenCodeAgent(
      parseAsset('---\nname: planner\ndescription: Plans\n---\nYou plan.'),
      'claude-opus-5',
    );
    expect(out).toContain('mode: subagent');
    expect(out).toContain('description: Plans');
    expect(out).toContain('model: anthropic/claude-opus-5');
    expect(out).toContain('You plan.');
    expect(out).not.toContain('effort');
  });

  it('omits a non-Anthropic model so OpenCode uses its configured default', () => {
    const out = renderOpenCodeAgent(
      parseAsset('---\nname: x\ndescription: X\n---\nBody'),
      'gpt-5.5',
    );
    expect(out).not.toContain('model: anthropic');
    expect(out).toContain('not Anthropic');
  });
});
