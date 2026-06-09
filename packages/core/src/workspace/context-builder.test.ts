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
});
