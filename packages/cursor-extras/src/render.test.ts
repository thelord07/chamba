import { describe, expect, it } from 'vitest';
import { parseAsset, renderCursorAgent, renderCursorCommand } from './render.js';

describe('renderCursorCommand', () => {
  it('emits the plain body (no frontmatter) and keeps $ARGUMENTS', () => {
    const out = renderCursorCommand(
      parseAsset('---\ndescription: Orchestrate\nargument-hint: "<task>"\n---\nDo $ARGUMENTS.\n'),
    );
    expect(out.trim()).toBe('Do $ARGUMENTS.');
    expect(out).not.toContain('---');
    expect(out).not.toContain('description:');
  });
});

describe('renderCursorAgent', () => {
  it('emits name/description and a bare Anthropic model from the reparto', () => {
    const out = renderCursorAgent(
      parseAsset('---\nname: planner\ndescription: Plans\n---\nYou plan.'),
      'claude-opus-5',
    );
    expect(out).toContain('name: planner');
    expect(out).toContain('description: Plans');
    expect(out).toContain('model: claude-opus-5');
    expect(out).not.toContain('anthropic/'); // Cursor takes bare ids, not provider-scoped
    expect(out).toContain('You plan.');
  });

  it('falls back to model: inherit for a non-Anthropic model', () => {
    const out = renderCursorAgent(parseAsset('---\nname: x\ndescription: X\n---\nBody'), 'gpt-5.5');
    expect(out).toContain('model: inherit');
    expect(out).not.toContain('gpt-5.5');
  });
});
