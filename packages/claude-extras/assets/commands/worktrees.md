---
description: List chamba git worktrees, or clean one up (keeping its branch)
argument-hint: list | cleanup <branch>
---

Manage chamba git worktrees for: **$ARGUMENTS**

- For `list` (or empty): call `chamba_list_worktrees` and show the table.
- For `cleanup <branch>`: call `chamba_cleanup_worktree` with that branch.
  Remember: this removes only the worktree directory — the branch is KEPT for you
  to review and merge by hand. Report the suggested `git merge --no-ff` command.

Never delete a branch or merge automatically.
