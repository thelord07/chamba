---
"@chamba/core": patch
"@chamba/adapters": patch
"@chamba/mcp": patch
"@chamba/claude-extras": patch
---

Workspace scanner: skip linked git worktrees.

A linked worktree has a `.git` *file* (a gitdir pointer) rather than a `.git`
directory. The scanner now detects and skips nested worktrees so their
checked-out copies no longer show up as duplicate projects in
`.chamba/workspace.md`. If chamba is pointed straight at a worktree, it's still
scanned (depth 0 is respected).
