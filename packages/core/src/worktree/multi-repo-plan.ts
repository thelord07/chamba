import type { WorktreeConfig } from '../config/worktrees.js';
import { joinPath } from '../util/path.js';

export interface WorktreePlanItem {
  /** Repo name (a directory under the workspace root). */
  repo: string;
  /** Absolute path to the main repo checkout. */
  repoPath: string;
  /** Absolute path where the worktree will be created. */
  worktreePath: string;
  /** The ticket branch (shared across repos). */
  branch: string;
}

export interface PlanWorktreesInput {
  workspaceRoot: string;
  ticket: string;
  /** Already-resolved repo names. */
  repos: string[];
  config: WorktreeConfig;
}

/**
 * Make a ticket id safe as a single git ref / path component, **preserving
 * case** (git refs are case-sensitive, so `TICKET-123` must not become
 * `ticket-123` or it wouldn't match an existing branch).
 */
export function safeTicket(ticket: string): string {
  const s = ticket
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.\.+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return s.length > 0 ? s : 'ticket';
}

/** Branch shared across repos: `<branchPrefix><ticket>`. */
export function buildTicketBranch(branchPrefix: string, ticket: string): string {
  return `${branchPrefix}${safeTicket(ticket)}`;
}

/** Where a repo's worktree lives, per layout. */
export function worktreePathFor(
  config: WorktreeConfig,
  workspaceRoot: string,
  ticket: string,
  repo: string,
): string {
  const t = safeTicket(ticket);
  if (config.layout === 'nested') {
    // <workspaceRoot>/<repo>/<root>/<ticket>
    return joinPath(workspaceRoot, repo, config.root, t);
  }
  // sibling: <workspaceRoot>/<root>/<ticket>/<repo>
  return joinPath(workspaceRoot, config.root, t, repo);
}

/** Directory where the editor workspace file is written. */
export function editorWorkspaceDir(
  config: WorktreeConfig,
  workspaceRoot: string,
  ticket: string,
): string {
  if (config.layout === 'nested') return workspaceRoot;
  return joinPath(workspaceRoot, config.root, safeTicket(ticket));
}

/** Pure plan: one item per repo. No IO. */
export function planWorktrees(input: PlanWorktreesInput): WorktreePlanItem[] {
  const { workspaceRoot, ticket, repos, config } = input;
  const branch = buildTicketBranch(config.branchPrefix, ticket);
  return repos.map((repo) => ({
    repo,
    repoPath: joinPath(workspaceRoot, repo),
    worktreePath: worktreePathFor(config, workspaceRoot, ticket, repo),
    branch,
  }));
}

/**
 * Content of the `.code-workspace` file: each repo's worktree as a folder.
 * Paths are made relative to `baseDir` when nested under it (the sibling case,
 * where they become just the repo name), otherwise absolute.
 */
export function editorWorkspaceContent(items: WorktreePlanItem[], baseDir: string): string {
  const prefix = `${baseDir}/`;
  const folders = items.map((item) => {
    const path = item.worktreePath.startsWith(prefix)
      ? item.worktreePath.slice(prefix.length)
      : item.worktreePath;
    return { path };
  });
  return `${JSON.stringify({ folders }, null, 2)}\n`;
}
