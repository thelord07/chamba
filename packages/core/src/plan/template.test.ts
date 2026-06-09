import { describe, expect, it } from 'vitest';
import type { Workspace } from '../workspace/workspace.js';
import { generatePlanTemplate, suggestFilesLikelyTouched, suggestSubtasks } from './template.js';

describe('generatePlanTemplate', () => {
  it('produces all template sections', () => {
    const md = generatePlanTemplate({ task: 'add a health check' });
    for (const heading of [
      '# Plan: add a health check',
      '## Goal',
      '## Acceptance criteria',
      '## Subtasks',
      '## Risks',
      '## Files likely touched',
    ]) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('**implementer**');
    expect(md).toContain('**tester**');
  });

  it('includes a context section only when context is given', () => {
    expect(generatePlanTemplate({ task: 't' })).not.toContain('## Context');
    expect(generatePlanTemplate({ task: 't', context: 'workspace info' })).toContain('## Context');
  });

  it('seeds files likely touched from workspace projects', () => {
    const workspace: Workspace = {
      root: '/r',
      description: 'x',
      languages: [],
      conventions: [],
      projects: [
        { name: 'root', path: '.' },
        { name: 'api', path: 'packages/api' },
      ],
      folderMap: ['packages'],
    };
    expect(suggestFilesLikelyTouched(workspace)).toEqual(['packages/api']);
    expect(generatePlanTemplate({ task: 't', workspace })).toContain('packages/api');
  });

  it('suggests an implementer and a tester subtask', () => {
    expect(suggestSubtasks().map((s) => s.worker)).toEqual(['implementer', 'tester']);
  });
});
