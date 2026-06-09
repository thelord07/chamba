import { describe, expect, it } from 'vitest';
import { DEFAULT_WORKTREE_CONFIG, type WorktreeConfig } from '../config/worktrees.js';
import {
  buildTicketBranch,
  editorWorkspaceContent,
  editorWorkspaceDir,
  planWorktrees,
  safeTicket,
  worktreePathFor,
} from './multi-repo-plan.js';

const sibling: WorktreeConfig = { ...DEFAULT_WORKTREE_CONFIG, root: 'WORKTREES' };
const nested: WorktreeConfig = {
  ...DEFAULT_WORKTREE_CONFIG,
  layout: 'nested',
  root: '.chamba/worktrees',
};

describe('safeTicket', () => {
  it('preserves case (git refs are case-sensitive)', () => {
    expect(safeTicket('TICKET-123')).toBe('TICKET-123');
  });

  it('strips ref-unsafe characters', () => {
    expect(safeTicket('feat/AB 12:x')).toBe('feat-AB-12-x');
  });
});

describe('buildTicketBranch', () => {
  it('joins prefix + ticket, preserving case', () => {
    expect(buildTicketBranch('ticket/', 'TICKET-123')).toBe('ticket/TICKET-123');
    expect(buildTicketBranch('chamba/', 'TICKET-123')).toBe('chamba/TICKET-123');
  });
});

describe('worktreePathFor', () => {
  it('sibling: <root>/<ticket>/<repo> under the workspace', () => {
    expect(worktreePathFor(sibling, '/ws', 'T-1', 'api')).toBe('/ws/WORKTREES/T-1/api');
  });

  it('nested: <repo>/<root>/<ticket> under the workspace', () => {
    expect(worktreePathFor(nested, '/ws', 'T-1', 'api')).toBe('/ws/api/.chamba/worktrees/T-1');
  });
});

describe('planWorktrees', () => {
  it('produces one item per repo with a shared branch', () => {
    const items = planWorktrees({
      workspaceRoot: '/ws',
      ticket: 'TICKET-9',
      repos: ['api', 'web'],
      config: { ...sibling, branchPrefix: 'ticket/' },
    });
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.branch === 'ticket/TICKET-9')).toBe(true);
    expect(items[0]).toMatchObject({
      repo: 'api',
      repoPath: '/ws/api',
      worktreePath: '/ws/WORKTREES/TICKET-9/api',
    });
  });
});

describe('editorWorkspaceContent', () => {
  it('uses repo-relative folders for the sibling layout', () => {
    const items = planWorktrees({
      workspaceRoot: '/ws',
      ticket: 'T-1',
      repos: ['api', 'web'],
      config: sibling,
    });
    const dir = editorWorkspaceDir(sibling, '/ws', 'T-1');
    const json = JSON.parse(editorWorkspaceContent(items, dir));
    expect(json.folders).toEqual([{ path: 'api' }, { path: 'web' }]);
  });

  it('keeps folders relative to the workspace root for the nested layout', () => {
    const items = planWorktrees({
      workspaceRoot: '/ws',
      ticket: 'T-1',
      repos: ['api'],
      config: nested,
    });
    const dir = editorWorkspaceDir(nested, '/ws', 'T-1');
    const json = JSON.parse(editorWorkspaceContent(items, dir));
    expect(json.folders[0].path).toBe('api/.chamba/worktrees/T-1');
  });

  it('uses an absolute folder when a worktree is outside the base dir', () => {
    const json = JSON.parse(
      editorWorkspaceContent(
        [{ repo: 'api', repoPath: '/other/api', worktreePath: '/other/api/wt', branch: 'b' }],
        '/ws',
      ),
    );
    expect(json.folders[0].path).toBe('/other/api/wt');
  });
});
