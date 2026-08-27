import type { ProcessPort } from '../ports/process.js';
import { joinPath } from '../util/path.js';
import { buildBranchName, worktreeRelativePath } from './branch-naming.js';
import { type ListedWorktree, parseWorktreePorcelain } from './porcelain.js';

export type { ListedWorktree } from './porcelain.js';

export class WorktreeError extends Error {
  override readonly name = 'WorktreeError';
}

export interface WorktreeHandle {
  branch: string;
  path: string;
  taskSlug: string;
  workerId: string;
}

export interface CreateWorktreeInput {
  root: string;
  taskSlug: string;
  workerId: string;
  /** `YYYY-MM-DD` for the branch name. */
  date: string;
  baseBranch?: string;
}

export interface CleanupResult {
  removed: boolean;
  branchKept: boolean;
  mergeSuggestion: string;
}

/**
 * Manage git worktrees for isolated parallel work.
 *
 * Safety guarantees (see CLAUDE.md gotchas):
 * - `cleanup` removes the worktree directory but NEVER deletes the branch and
 *   NEVER merges. The branch stays for the human to review and merge by hand.
 * - `git worktree remove` is run WITHOUT `--force`, so a dirty worktree fails
 *   loudly instead of silently discarding work.
 */
export class WorktreeManager {
  constructor(private readonly process: ProcessPort) {}

  async create(input: CreateWorktreeInput): Promise<WorktreeHandle> {
    const branch = buildBranchName({
      date: input.date,
      taskSlug: input.taskSlug,
      workerId: input.workerId,
    });
    const path = joinPath(input.root, worktreeRelativePath(input.taskSlug, input.workerId));

    const args = ['worktree', 'add', '-b', branch, path];
    if (input.baseBranch) args.push(input.baseBranch);

    const result = await this.process.exec('git', args, { cwd: input.root });
    if (result.exitCode !== 0) {
      throw new WorktreeError(
        `git worktree add failed: ${result.stderr.trim() || 'unknown error'}`,
      );
    }
    return { branch, path, taskSlug: input.taskSlug, workerId: input.workerId };
  }

  async list(root: string): Promise<ListedWorktree[]> {
    const result = await this.process.exec('git', ['worktree', 'list', '--porcelain'], {
      cwd: root,
    });
    if (result.exitCode !== 0) return [];
    return parseWorktreePorcelain(result.stdout);
  }

  async cleanup(root: string, branch: string): Promise<CleanupResult> {
    const worktrees = await this.list(root);
    const target = worktrees.find((w) => w.branch === branch);
    if (!target) {
      throw new WorktreeError(`No worktree found for branch '${branch}'.`);
    }

    // NO --force: a worktree with uncommitted changes must fail, not be discarded.
    const result = await this.process.exec('git', ['worktree', 'remove', target.path], {
      cwd: root,
    });
    if (result.exitCode !== 0) {
      throw new WorktreeError(
        `git worktree remove failed (uncommitted changes?): ${result.stderr.trim() || 'unknown error'}`,
      );
    }

    // The branch is intentionally kept. chamba never runs `git branch -D` or `git merge`.
    return { removed: true, branchKept: true, mergeSuggestion: `git merge --no-ff ${branch}` };
  }
}
