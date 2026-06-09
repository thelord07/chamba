import { joinPath } from '../util/path.js';
import { WORKSPACE_DIR } from '../workspace/workspace.js';

export interface BranchNameInput {
  /** `YYYY-MM-DD`. */
  date: string;
  taskSlug: string;
  workerId: string;
}

/**
 * Sanitize a value into a single git-ref-safe path component: lowercase, no
 * spaces, no characters git forbids in refs (`~^:?*[\` etc.), no leading/trailing
 * dots or dashes.
 */
export function slugifyForGit(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/\.\.+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug.length > 0 ? slug : 'x';
}

/** Branch convention: `chamba/<date>-<task-slug>/<worker-id>`. */
export function buildBranchName(input: BranchNameInput): string {
  return `chamba/${input.date}-${slugifyForGit(input.taskSlug)}/${slugifyForGit(input.workerId)}`;
}

/** Worktree directory relative to the repo root. */
export function worktreeRelativePath(taskSlug: string, workerId: string): string {
  return joinPath(WORKSPACE_DIR, 'worktrees', slugifyForGit(taskSlug), slugifyForGit(workerId));
}
