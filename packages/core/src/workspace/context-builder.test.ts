import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { ContextBuilder } from './context-builder.js';
import type { Workspace } from './workspace.js';

const workspace: Workspace = {
  root: '/proj',
  description: 'A tiny HTTP API.',
  languages: ['TypeScript'],
  framework: 'Express',
  conventions: [],
  projects: [{ name: 'proj', path: '.', language: 'TypeScript' }],
  ruleSources: [],
  folderMap: ['src'],
};

describe('ContextBuilder', () => {
  it('includes a workspace section even without a vault', async () => {
    const builder = new ContextBuilder(new MemoryFilesystem({}));
    const built = await builder.build({ workspace, task: 'add a health check' });

    expect(built.context).toContain('## Workspace context');
    expect(built.context).toContain('A tiny HTTP API.');
    expect(built.relevantNotes).toEqual([]);
  });

  it('surfaces vault notes relevant to the task by keyword', async () => {
    const fs = new MemoryFilesystem({
      '/v/.obsidian/app.json': '{}',
      '/v/auth.md': '# Auth\n\nWe use magic links for authentication via Resend.\n',
      '/v/cooking.md': '# Cooking\n\nUnrelated notes about pasta.\n',
    });
    const built = await new ContextBuilder(fs).build({
      workspace,
      task: 'add authentication with magic links',
      vaultPath: '/v',
    });

    expect(built.relevantNotes).toEqual(['/v/auth.md']);
    expect(built.context).toContain('## Relevant notes');
    expect(built.context).toContain('auth.md');
  });

  it('clamps the context to the configured size', async () => {
    const builder = new ContextBuilder(new MemoryFilesystem({}));
    const built = await builder.build({ workspace, task: 'x', maxTokens: 5 });
    expect(built.context.length).toBeLessThanOrEqual(5 * 4);
  });

  it('includes a coding rules section with fresh excerpts, non-exclusive', async () => {
    const fs = new MemoryFilesystem({
      '/proj/api/.cursor/rules/style.mdc': '# Cursor style\nUse named exports.',
      '/proj/web/CLAUDE.md': '# Claude rules\nMatch surrounding code.',
    });
    const ws: Workspace = {
      ...workspace,
      ruleSources: [
        { repo: 'api', editor: 'Cursor', path: 'api/.cursor/rules/style.mdc' },
        { repo: 'web', editor: 'Claude Code', path: 'web/CLAUDE.md' },
      ],
    };
    const built = await new ContextBuilder(fs).build({ workspace: ws, task: 'anything' });

    expect(built.context).toContain('## Coding rules');
    expect(built.context).toContain('api/.cursor/rules/style.mdc');
    expect(built.context).toContain('Use named exports.');
    expect(built.context).toContain('web/CLAUDE.md');
    expect(built.context).toContain('Match surrounding code.');
  });

  it('skips the rules section when includeRules is false', async () => {
    const fs = new MemoryFilesystem({ '/proj/CLAUDE.md': '# rules' });
    const ws: Workspace = {
      ...workspace,
      ruleSources: [{ repo: '.', editor: 'Claude Code', path: 'CLAUDE.md' }],
    };
    const built = await new ContextBuilder(fs).build({
      workspace: ws,
      task: 'x',
      includeRules: false,
    });
    expect(built.context).not.toContain('## Coding rules');
  });
});
