# @chamba/mcp

## 0.20.1

### Patch Changes

- docs(mcp): complete the npm README tools list

  The `@chamba/mcp` README's tools list had been frozen at ~0.10 — it was missing the tools
  added since (`chamba_load_design`, `chamba_design_prefs`, `chamba_qa_capabilities`,
  `chamba_resource_budget`, `chamba_load_skills`, `chamba_doctor`, `chamba_vault_status`,
  `chamba_save_plan`, `chamba_get_agent_config`, the multi-worktree tools). Rewrote it grouped
  by area and noted the repo-safe vault bootstrap, so the npm package page reflects reality.

  - @chamba/adapters@0.20.1
  - @chamba/core@0.20.1

## 0.20.0

### Minor Changes

- fix(vault): bootstrap the vault outside your repos (repo-safe)

  `workspace_init` used to seed the Obsidian vault at the workspace root — so when that folder
  was a git repo, `.obsidian/`, `Workspace overview.md`, `proyectos/`, `plans/` and
  `.chamba/memory/` could get committed. Now it bootstraps a **global vault at `~/.chamba/vault`**
  (outside any repo, autodetected via the search roots); a personal vault in Documents/Notes/
  Obsidian still wins. If a vault is found **inside** a git work tree, its artifacts are
  auto-gitignored as a backstop, and `doctor` warns when the active vault lives inside a repo.
  New core helpers `findGitRoot` and `ensureVaultGitignored` (pure, no `git` process, no LLM).

### Patch Changes

- Updated dependencies
  - @chamba/core@0.20.0
  - @chamba/adapters@0.20.0

## 0.19.0

### Patch Changes

- Updated dependencies
  - @chamba/core@0.19.0
  - @chamba/adapters@0.19.0

## 0.18.0

### Minor Changes

- feat(design): linkable design sources + UI-architecture preference

  Link a design once and chamba resolves it per ticket. A design source is a pointer in
  `.chamba/design/<name>.md` that LINKS an external location (kept out of the repo): a Figma
  URL, a folder of mockups/specs, and/or a standalone `.html`/`.zip` prototype (e.g. a Claude
  Code export). New tool `chamba_load_design` returns the brief + Figma link + asset paths (no
  LLM). New tool `chamba_design_prefs` gets/sets the UI-architecture preference (Atomic Design,
  Feature-Sliced, …) — web and mobile separately — so the planner asks once and reuses it. The
  planner/implementer/qa build and verify against the linked source and the saved architecture,
  opening the standalone prototype as the behavioural target. New `/design` command links a
  source and manages the preference. chamba links and lists; the editor's model + Figma MCP /
  browser does the visual work.

### Patch Changes

- Updated dependencies
  - @chamba/core@0.18.0
  - @chamba/adapters@0.18.0

## 0.17.0

### Patch Changes

- Updated dependencies
  - @chamba/core@0.17.0
  - @chamba/adapters@0.17.0

## 0.16.0

### Minor Changes

- feat(qa): mobile QA — detect React Native/Expo and run on simulators/emulators via MCP

  The workspace scanner detects React Native / Expo apps (Expo managed vs bare, EAS,
  dev-client, and mobile E2E tooling like Detox/Maestro/Appium) into a `## Mobile` section.
  New tool `chamba_qa_capabilities` (read-only, no LLM) reports web vs mobile, the E2E
  tooling present, and enumerates the iOS simulators / Android emulators actually available
  on the machine (`xcrun simctl` / `adb` / `emulator -list-avds` — it lists, never boots).
  The `qa` agent gains a mobile mode: it drives a simulator/emulator through the editor's
  Expo/mobile MCP if one is configured, else co-pilots via `expo start` or Expo Go on a
  physical device. The planner emits a mobile-aware `## QA plan` (platform, launch, target)
  and the heuristic reviewer warns `mobile-qa-missing-target`. chamba never boots a device
  or calls Expo — the editor's MCP or the terminal does. Login stays human.

### Patch Changes

- Updated dependencies
  - @chamba/core@0.16.0
  - @chamba/adapters@0.16.0

## 0.15.0

### Minor Changes

- Tier 3 #2: skills/playbooks registry (index-first, no LLM).

  New `chamba_load_skills` tool: reusable conventions live in `.chamba/skills/*.md` (project,
  then `~/.chamba/skills`) with frontmatter `{ name, description, scope? }`. chamba matches the
  task against each skill's `description` and returns the relevant ones **with their body** plus
  the full catalog — the model reads a cheap index and only pulls the playbooks that apply. Zero
  LLM on chamba's side. `/ticket` and `/orq` call it at the start of a task. Ships **empty and
  opt-in** — you and your team fill it over time.

### Patch Changes

- Updated dependencies
  - @chamba/core@0.15.0
  - @chamba/adapters@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies
  - @chamba/core@0.14.0
  - @chamba/adapters@0.14.0

## 0.13.0

### Patch Changes

- Updated dependencies
  - @chamba/core@0.13.0
  - @chamba/adapters@0.13.0

## 0.12.0

### Minor Changes

- Resource-aware parallelism + multi-repo doctor fix.

  **Safe parallelism (no LLM).** New `chamba_resource_budget` tool reads live RAM, CPU
  cores and load and returns how many worktrees/subagents to run at once, so a multi-repo
  `/ticket` fans out in **waves** instead of thrashing or OOM-ing an 8/16 GB machine.
  `chamba_create_worktrees` now returns `recommendedParallelism`, and the `/ticket` and
  `/orq` prompts run per-repo workers in waves of that size. Cap or tune it with
  `worktrees.maxParallel` / `worktrees.perWorkerMemMB` in `.chamba/config.json`. Conservative
  by default (2 GB/worker estimate) — an OOM is a worse failure than one fewer parallel worker.

  **Doctor: multi-repo aware.** `chamba doctor` no longer false-positives "not a git repo"
  on a multi-repo container (where the root is a folder of repos, not a repo itself) — it
  reports the repo count instead. It also adds a `system` line: total/free RAM, cores, and
  the safe parallel-worker ceiling.

### Patch Changes

- Updated dependencies
  - @chamba/core@0.12.0
  - @chamba/adapters@0.12.0

## 0.11.1

### Patch Changes

- @chamba/adapters@0.11.1
- @chamba/core@0.11.1

## 0.11.0

### Patch Changes

- Updated dependencies [ea415bf]
  - @chamba/core@0.11.0
  - @chamba/adapters@0.11.0

## 0.10.0

### Minor Changes

- 64ce3be: feat(doctor): environment health check — `chamba_doctor` tool + `npx @chamba/mcp doctor`

  A no-LLM diagnostic that validates the setup and tells you exactly what to fix:
  Node version, git, whether the cwd is a git repo, `.chamba/workspace.md`, agent
  config validity, the Obsidian vault connection, the log directory, and worktrees.
  Returns a pass/warn/fail report (and a non-zero exit code from the CLI when a check
  fails, so it works as a CI gate). Shared pure logic in `@chamba/core` (`runDoctor`,
  `renderDoctorReport`) drives both the MCP tool and the CLI subcommand.

- ddd5298: feat(memory): index-first vault recall + per-project grouping (Engram-style)

  Recall no longer reads every note. Each vault folder keeps a lightweight `INDEX.md`
  (`{title, path, description}`) that `chamba_load_context` scans first, opening full
  notes only for the top matches — with a full-scan fallback so recall never regresses
  on a legacy vault or an index miss. `chamba_summarize_to_vault` and `chamba_save_plan`
  now group notes under a stable `<folder>/<owner-repo>/` subfolder derived from the git
  remote (`slugifyGitRemote`), so every note for the same repo lands together and stays
  deduped. Still no LLM — matching and indexing are mechanical.

### Patch Changes

- Updated dependencies [64ce3be]
- Updated dependencies [ddd5298]
- Updated dependencies [d7208fa]
  - @chamba/core@0.10.0
  - @chamba/adapters@0.10.0

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
