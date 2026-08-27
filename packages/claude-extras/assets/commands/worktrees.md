---
description: List chamba git worktrees, or clean one up (keeping its branch)
argument-hint: list | status | preview | cleanup <branch>
---

Manage chamba git worktrees for: **$ARGUMENTS**

- For `list` or `status` (or empty): call `chamba_worktree_status` (or
  `chamba_list_worktrees`) and show dirty/stale/ahead-behind + file overlap.
  Overlapping files means those worktrees must run sequentially.
- For `preview`: call `chamba_conflict_preview` (`git merge-tree` dry-run).
  Never merge.
- For `cleanup <branch>`: call `chamba_cleanup_worktree` with that branch.
  Remember: this removes only the worktree directory — the branch is KEPT for you
  to review and merge by hand. Report the suggested `git merge --no-ff` command.
- For `env` / ports: call `chamba_worktree_env` only when `worktrees.ports.enabled`
  is on — it writes `.env.local`, never kills a process, never copies `node_modules`.

Never delete a branch or merge automatically.
