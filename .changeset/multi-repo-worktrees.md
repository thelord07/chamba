---
"@chamba/core": minor
"@chamba/adapters": minor
"@chamba/mcp": minor
"@chamba/claude-extras": minor
---

Multi-repo worktrees, generic and workspace-aware.

- **core**: a `worktrees` config block (layout, root, branchPrefix, baseBranch,
  copyEnvFiles, editorWorkspace, repos, command), pure planning (per-repo paths,
  a shared `<branchPrefix><ticket>` branch, `.code-workspace` content), and a
  `MultiRepoWorktreeManager` over the ports — reuses an existing local/remote
  branch or forks from the base, optionally copies git-ignored `.env*`, and never
  deletes branches or uses `--force`. `loadConfig` now also resolves `worktrees`.
- **mcp**: `chamba_create_worktrees` and `chamba_cleanup_worktrees` (tools 14–15).
  Config-driven and workspace-aware (autodetects git repos), with a
  `worktrees.command` escape hatch to shell out to a team's own script.
- **claude-extras**: a generic `/ticket` orchestrator-worker command that delegates
  to the configured subagents (planner/reviewer/implementer/tester), runs to the
  end with a single final gate, and never commits/merges/pushes; a new `planner`
  subagent; `config worktrees <show|init>`; `/orq` updated to delegate explicitly.
