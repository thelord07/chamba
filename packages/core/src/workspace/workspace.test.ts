import { describe, expect, it } from 'vitest';
import { renderWorkspaceMarkdown, type Workspace } from './workspace.js';

const sample: Workspace = {
  root: '/p',
  description: 'A tiny HTTP API.',
  languages: ['TypeScript'],
  framework: 'Express',
  conventions: ['Biome for lint + format'],
  projects: [{ name: 'proj', path: '.', language: 'TypeScript', framework: 'Express' }],
  folderMap: ['src', 'test'],
};

describe('renderWorkspaceMarkdown', () => {
  it('produces all required sections', () => {
    const md = renderWorkspaceMarkdown(sample);
    for (const heading of [
      '## Description',
      '## Languages',
      '## Framework',
      '## Conventions',
      '## Active projects',
      '## Folder map',
    ]) {
      expect(md).toContain(heading);
    }
  });

  it('renders content from the workspace', () => {
    const md = renderWorkspaceMarkdown(sample);
    expect(md).toContain('A tiny HTTP API.');
    expect(md).toContain('- TypeScript');
    expect(md).toContain('**proj**');
    expect(md).toContain('- src/');
  });

  it('is deterministic (no timestamps) so reload diffs are meaningful', () => {
    expect(renderWorkspaceMarkdown(sample)).toBe(renderWorkspaceMarkdown(sample));
  });
});
