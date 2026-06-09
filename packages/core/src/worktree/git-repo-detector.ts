import type { FilesystemPort } from '../ports/filesystem.js';
import { joinPath } from '../util/path.js';

/** True if `dir` contains a `.git` **directory** (a main checkout, not a worktree). */
async function hasGitDir(fs: FilesystemPort, dir: string): Promise<boolean> {
  try {
    const entries = await fs.readDir(dir);
    return entries.some((e) => e.name === '.git' && e.isDirectory);
  } catch {
    return false;
  }
}

/**
 * The immediate child directories of `workspaceRoot` that are git repos
 * (have a `.git` directory). A `.git` *file* marks a linked worktree, which is
 * deliberately excluded — consistent with the workspace scanner.
 */
export async function detectGitRepos(fs: FilesystemPort, workspaceRoot: string): Promise<string[]> {
  let entries: Awaited<ReturnType<FilesystemPort['readDir']>>;
  try {
    entries = await fs.readDir(workspaceRoot);
  } catch {
    return [];
  }

  const repos: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    if (await hasGitDir(fs, joinPath(workspaceRoot, entry.name))) repos.push(entry.name);
  }
  return repos.sort();
}
