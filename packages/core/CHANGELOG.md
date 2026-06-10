# @chamba/core

## 0.3.1

## 0.3.0

### Minor Changes

- 7e3098e: Multi-repo worktrees, generic and workspace-aware.

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

## 0.2.1

### Patch Changes

- 678ba4a: Workspace scanner: skip linked git worktrees.

  A linked worktree has a `.git` _file_ (a gitdir pointer) rather than a `.git`
  directory. The scanner now detects and skips nested worktrees so their
  checked-out copies no longer show up as duplicate projects in
  `.chamba/workspace.md`. If chamba is pointed straight at a worktree, it's still
  scanned (depth 0 is respected).

## 0.2.0

### Minor Changes

- 313229c: Per-agent configuration (model + effort per role).

  - **core**: model catalog (Anthropic, OpenAI, Gemini, Ollama), agent roles,
    hardcoded recommended defaults, Zod schema, and a layered loader
    (defaults ← global ← project, merged per role and per field). Corrupt configs
    degrade to defaults with a warning. chamba still never calls an LLM — this is
    declarative metadata.
  - **mcp**: new read-only tool `chamba_get_agent_config` exposing the resolved
    model + effort + hint per role to any MCP editor.
  - **claude-extras**: subagent frontmatter (`model` + `effort`) is now generated
    from the config; an install wizard (non-blocking, CI-safe with `--defaults`)
    and a `config` CLI (`show`/`models`/`set`/`reset`/`wizard`/`apply`/`edit`) let
    you pick and reconfigure models per role. `effort` is provider-neutral
    (`low|medium|high|extreme`) and mapped per provider (e.g. `extreme` → `max`
    in Claude Code).

## 0.1.0

### Minor Changes

- First public release of chamba: an MCP server that adds orchestration, workspace
  context, git worktrees and Obsidian memory to any MCP-capable editor — no API key,
  the editor's model does the reasoning.

  Twelve tools: workspace init/show/reload, load context, summarize to vault, generate
  plan, review plan (heuristic, no LLM), create/list/cleanup worktree, remember, recall.
  Plus the optional `@chamba/claude-extras` installer (slash commands, subagents, hooks)
  for Claude Code.
