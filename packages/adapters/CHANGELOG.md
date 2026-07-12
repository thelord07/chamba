# @chamba/adapters

## 0.13.0

### Patch Changes

- Updated dependencies
  - @chamba/core@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies
  - @chamba/core@0.12.0

## 0.11.1

### Patch Changes

- @chamba/core@0.11.1

## 0.11.0

### Patch Changes

- Updated dependencies [ea415bf]
  - @chamba/core@0.11.0

## 0.10.0

### Patch Changes

- Updated dependencies [64ce3be]
- Updated dependencies [ddd5298]
- Updated dependencies [d7208fa]
  - @chamba/core@0.10.0

## 0.9.0

### Patch Changes

- Updated dependencies [a515a71]
  - @chamba/core@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [9c0b22f]
  - @chamba/core@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [4ec6bda]
  - @chamba/core@0.7.0

## 0.6.2

### Patch Changes

- @chamba/core@0.6.2

## 0.6.1

### Patch Changes

- @chamba/core@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [1c9d77d]
  - @chamba/core@0.6.0

## 0.5.2

### Patch Changes

- Updated dependencies [477bbd5]
  - @chamba/core@0.5.2

## 0.5.1

### Patch Changes

- @chamba/core@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [a3c707a]
  - @chamba/core@0.5.0

## 0.4.0

### Minor Changes

- 918451b: Multi-editor coding rules in context.

  chamba now discovers each repo's coding-rule files across editor conventions —
  `.cursor/rules`, `.cursorrules`, `CLAUDE.md`, `.claude/rules`, `.windsurfrules`,
  `.trae`, `.github/copilot-instructions.md`, `.clinerules`, `AGENTS.md` — and reads
  them **non-exclusively** (Claude Code users still get the Cursor/Trae rules).

  - **core**: new `rules.ts` (catalog + `detectRuleSources` + `readRuleExcerpts`).
    The scanner enumerates the workspace's repos (root + child git repos + projects)
    and records a `ruleSources` inventory; `workspace.md` gains a `## Coding rules`
    section. `ContextBuilder` adds a `## Coding rules` block that reads each rule
    file fresh (clamped, budgeted) — so the rules in context are always current and
    never copied to the vault (no drift).
  - **mcp**: `chamba_load_context` gains `includeRules` (default true).

### Patch Changes

- Updated dependencies [918451b]
  - @chamba/core@0.4.0

## 0.3.2

### Patch Changes

- 8ac35e8: Obsidian vault: diagnostics + auto-correct a `.obsidian` path.

  - **core**: `ObsidianDetector` now auto-corrects a vault path that points at the
    `.obsidian` folder to its parent (the actual vault). A common misconfiguration
    made chamba write summaries into `.obsidian/proyectos/` and search notes inside
    `.obsidian/` instead of the real vault. New `listVaultNotes` + `normalizeVaultPath`.
  - **mcp**: new `chamba_vault_status` tool (#16) — shows the resolved vault path,
    whether it came from the env var or autodetection, and the markdown notes chamba
    can actually see (the same set `chamba_load_context` searches).
  - **claude-extras**: new `/vault` slash command to run the diagnostic.

- Updated dependencies [8ac35e8]
  - @chamba/core@0.3.2

## 0.3.1

### Patch Changes

- @chamba/core@0.3.1

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

### Patch Changes

- Updated dependencies [7e3098e]
  - @chamba/core@0.3.0

## 0.2.1

### Patch Changes

- 678ba4a: Workspace scanner: skip linked git worktrees.

  A linked worktree has a `.git` _file_ (a gitdir pointer) rather than a `.git`
  directory. The scanner now detects and skips nested worktrees so their
  checked-out copies no longer show up as duplicate projects in
  `.chamba/workspace.md`. If chamba is pointed straight at a worktree, it's still
  scanned (depth 0 is respected).

- Updated dependencies [678ba4a]
  - @chamba/core@0.2.1

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

### Patch Changes

- Updated dependencies [313229c]
  - @chamba/core@0.2.0

## 0.1.0

### Minor Changes

- First public release of chamba: an MCP server that adds orchestration, workspace
  context, git worktrees and Obsidian memory to any MCP-capable editor — no API key,
  the editor's model does the reasoning.

  Twelve tools: workspace init/show/reload, load context, summarize to vault, generate
  plan, review plan (heuristic, no LLM), create/list/cleanup worktree, remember, recall.
  Plus the optional `@chamba/claude-extras` installer (slash commands, subagents, hooks)
  for Claude Code.

### Patch Changes

- Updated dependencies
  - @chamba/core@0.1.0
