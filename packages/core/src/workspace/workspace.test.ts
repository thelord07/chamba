import { describe, expect, it } from 'vitest';
import { renderWorkspaceMarkdown, type Workspace } from './workspace.js';

const sample: Workspace = {
  root: '/p',
  description: 'A tiny HTTP API.',
  languages: ['TypeScript'],
  framework: 'Express',
  conventions: ['Biome for lint + format'],
  projects: [{ name: 'proj', path: '.', language: 'TypeScript', framework: 'Express' }],
  ruleSources: [{ repo: '.', editor: 'Cursor', path: '.cursor/rules/style.mdc' }],
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
      '## Auth',
      '## Coding rules',
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
    expect(md).toContain('.cursor/rules/style.mdc');
  });

  it('renders detected auth findings with packages and projects', () => {
    const md = renderWorkspaceMarkdown({
      ...sample,
      auth: [{ provider: 'Auth0', packages: ['@auth0/nextjs-auth0'], projects: ['webapp'] }],
    });
    expect(md).toContain('**Auth0**');
    expect(md).toContain('`@auth0/nextjs-auth0`');
    expect(md).toContain('(webapp)');
  });

  it('prompts to document auth by hand when none is detected', () => {
    const md = renderWorkspaceMarkdown(sample);
    expect(md).toContain('## Auth');
    expect(md).toContain('No auth library detected');
    expect(md).toContain('the qa agent never creates identity-provider users');
  });

  it('is deterministic (no timestamps) so reload diffs are meaningful', () => {
    expect(renderWorkspaceMarkdown(sample)).toBe(renderWorkspaceMarkdown(sample));
  });
});
