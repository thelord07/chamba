# @chamba/mcp

## 0.9.0

### Minor Changes

- a515a71: Save plans to the vault and surface open-in-editor commands.

  - New **`chamba_save_plan`** tool writes a finalized plan to the vault's `plans/` folder (`plans/<date>-<slug>.md`, tagged `[chamba, plan]`), alongside the run summaries that go under `proyectos/`. `VaultWriter` gained an optional `subdir` so both share one writer; `VAULT_PLANS_DIR` is exported from `@chamba/core`.
  - `/ticket` now saves the final plan (after the clarification gate) and `/orq` saves the approved plan — every plan is persisted, not just the end-of-run summary.
  - `/ticket`'s final report now prints two copy-paste commands below the message to open the work: `code <.code-workspace>` for VS Code and `cursor <.code-workspace>` for Cursor (falling back to the worktree directory).

### Patch Changes

- Updated dependencies [a515a71]
  - @chamba/core@0.9.0
  - @chamba/adapters@0.9.0

## 0.8.0

### Patch Changes

- Updated dependencies [9c0b22f]
  - @chamba/core@0.8.0
  - @chamba/adapters@0.8.0

## 0.7.0

### Patch Changes

- Updated dependencies [4ec6bda]
  - @chamba/core@0.7.0
  - @chamba/adapters@0.7.0

## 0.6.2

### Patch Changes

- @chamba/adapters@0.6.2
- @chamba/core@0.6.2

## 0.6.1

### Patch Changes

- 3f4c9c2: Add a `--version` flag (alias `-v`) to both bins.

  `npx @chamba/claude-extras --version` and `npx @chamba/mcp --version` now print the installed version and exit — handy for confirming which version `npx` actually resolved. The MCP server prints and exits before any protocol starts, so it doesn't interfere with normal stdio startup.

  - @chamba/adapters@0.6.1
  - @chamba/core@0.6.1

## 0.6.0

### Minor Changes

- 1c9d77d: `chamba_workspace_init` now bootstraps an Obsidian vault when none exists, so memory works from day one.

  - New `VaultInitializer` (`@chamba/core`) drops the `.obsidian/` marker at a given root and seeds a `Workspace overview.md` note rendered from the scan. Idempotent: it never recreates the marker or overwrites an existing overview.
  - `chamba_workspace_init` detects a vault (via `CHAMBA_OBSIDIAN_VAULT_PATH` or the usual search roots); if none is found it creates one at the workspace root and seeds the overview, otherwise it leaves the existing vault untouched. Because the workspace root is the first search root, the other tools (`load_context`, `summarize_to_vault`, `vault_status`) auto-detect it on the next run with no extra config. Opt out with `createVault: false`.
  - chamba never edits `.gitignore`; the tool's output notes that `.obsidian/` was created so you can ignore it if you don't want it committed.

### Patch Changes

- Updated dependencies [1c9d77d]
  - @chamba/core@0.6.0
  - @chamba/adapters@0.6.0

## 0.5.2

### Patch Changes

- Updated dependencies [477bbd5]
  - @chamba/core@0.5.2
  - @chamba/adapters@0.5.2

## 0.5.1

### Patch Changes

- @chamba/adapters@0.5.1
- @chamba/core@0.5.1

## 0.5.0

### Patch Changes

- Updated dependencies [a3c707a]
  - @chamba/core@0.5.0
  - @chamba/adapters@0.5.0

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
  - @chamba/adapters@0.4.0

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
  - @chamba/adapters@0.3.2

## 0.3.1

### Patch Changes

- @chamba/adapters@0.3.1
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
  - @chamba/adapters@0.3.0

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
  - @chamba/adapters@0.2.1

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
  - @chamba/adapters@0.2.0

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
  - @chamba/adapters@0.1.0
