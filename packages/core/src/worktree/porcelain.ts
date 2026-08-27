export interface ListedWorktree {
  path: string;
  head?: string;
  branch?: string;
}

/**
 * Parse `git worktree list --porcelain`. The first block is the primary
 * checkout; the rest are linked worktrees. Pure — no IO.
 */
export function parseWorktreePorcelain(output: string): ListedWorktree[] {
  const result: ListedWorktree[] = [];
  for (const block of output.split(/\n\s*\n/)) {
    let path: string | undefined;
    let head: string | undefined;
    let branch: string | undefined;
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      if (line.startsWith('worktree ')) path = line.slice('worktree '.length);
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length);
      else if (line.startsWith('branch '))
        branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    }
    if (path) result.push({ path, head, branch });
  }
  return result;
}
