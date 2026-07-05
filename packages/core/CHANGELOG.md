# @chamba/core

## 0.7.0

### Minor Changes

- 4ec6bda: Add an acceptance-QA phase: a `qa` agent that validates a ticket's acceptance criteria against the running app.

  - New configurable `qa` role (`@chamba/core`): default `claude-opus-4-7` / high effort. It shows up in `config show`, the wizard, and `chamba_get_agent_config` automatically.
  - The **planner** now emits a `## QA plan` for user-facing tickets — local seed, test users, URLs, login steps, and the expected behaviour per acceptance criterion. `validatePlan` warns (`missing-qa-plan`, non-blocking) when a user-facing plan lacks one.
  - New **qa** subagent: it adapts to the project — if the repo has Playwright/Cypress (or a browser MCP) it drives the browser; otherwise it runs the repos from the worktree, applies the local seed, and co-pilots with you (asks you to log in, tells you what to click) while validating each criterion. Reports PASS/FAIL, never commits.
  - `/ticket` runs the QA phase after verify when the plan has a `## QA plan`, and folds PASS/FAIL into the final acceptance-criteria checklist. New standalone `/qa <ticket>` command to run or re-run QA on its own.

## 0.6.2

## 0.6.1

## 0.6.0

### Minor Changes

- 1c9d77d: `chamba_workspace_init` now bootstraps an Obsidian vault when none exists, so memory works from day one.

  - New `VaultInitializer` (`@chamba/core`) drops the `.obsidian/` marker at a given root and seeds a `Workspace overview.md` note rendered from the scan. Idempotent: it never recreates the marker or overwrites an existing overview.
  - `chamba_workspace_init` detects a vault (via `CHAMBA_OBSIDIAN_VAULT_PATH` or the usual search roots); if none is found it creates one at the workspace root and seeds the overview, otherwise it leaves the existing vault untouched. Because the workspace root is the first search root, the other tools (`load_context`, `summarize_to_vault`, `vault_status`) auto-detect it on the next run with no extra config. Opt out with `createVault: false`.
  - chamba never edits `.gitignore`; the tool's output notes that `.obsidian/` was created so you can ignore it if you don't want it committed.

## 0.5.2

### Patch Changes

- 477bbd5: Add a clarification gate so `/ticket` resolves plan ambiguities before executing instead of guessing.

  - The **planner** now puts genuine forks (scope/behaviour changes, product decisions only the human can make) under a `## Open questions` section instead of silently assuming.
  - `validatePlan` warns (`unresolved-open-questions`, non-blocking) when the plan has an Open questions section with items that aren't marked answered — the signal for the orchestrator to ask.
  - `/ticket` gained a **clarification gate** between review and worktree creation: if the plan has unresolved open questions or `needs-approval` items, it asks you in one batch, folds your answers into the plan, and only then executes. Clear plans proceed without pausing. The gate applies to `-p` plans too. This is the one deliberate pause; after it, the flow runs to the end as before.

## 0.5.1

## 0.5.0

### Minor Changes

- a3c707a: Catch dead code after deletions and stop the /ticket flow from silently dropping acceptance criteria.

  - `validatePlan` now warns (`deletion-without-orphan-check`) when a plan removes code but never mentions verifying referential closure — orphaned callers or now-unused exports. Heuristic, no LLM, no code-graph: it just routes deletion plans toward the build/typecheck + dead-code check (knip / ts-prune) instead of a token grep that misses orphans whose name doesn't contain the deleted symbol.
  - The `/ticket` command gained a post-implementation **verify** stage: the reviewer subagent audits the real diff (not the plan) for referential closure, and the repo's build / typecheck / lint / dead-code check runs before reporting.
  - `/ticket` autonomy is now bounded by the plan's own gates: items the plan marks `needs-approval` are never acted on autonomously, and the final report must include an acceptance-criteria checklist plus a "Needs your decision" section — an AC can no longer be silently dropped under "run to the end".
  - The reviewer subagent's diff review now explicitly checks backward orphans (dead exports/helpers left by a deletion), not just forward breakage.

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
