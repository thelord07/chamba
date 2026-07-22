# @chamba/core

## 1.0.0

## 0.21.0

## 0.20.1

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

## 0.19.0

### Minor Changes

- feat(quality): release-quality pass — golden reviewer baseline, doctor CI gate, --yes, RELEASING

  Harden the release process on the way to 1.0.0. The installer gains a `--yes` flag (alias of
  `--defaults` / non-TTY) for non-interactive installs in CI and scripts, via a testable
  `isNonInteractive` helper. A golden test freezes the heuristic reviewer's verdicts across a
  corpus of representative plans, so any change to `validatePlan` shows up as a snapshot diff.
  CI now runs the built `doctor` as a smoke gate (it already exits non-zero when unhealthy), and
  two pre-existing `tsc --noEmit` errors are fixed so the Typecheck gate is green. Adds a
  `RELEASING.md` checklist documenting the manual and automated release paths and their gotchas.

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

## 0.17.0

### Minor Changes

- feat(workspace): support more editors — Gemini CLI, Codex, JetBrains, Trae, Zed, Kiro

  Add setup guides under `examples/` for six more MCP-capable editors, and teach the
  coding-rule scanner their conventions: `GEMINI.md` (Gemini CLI), `.junie/guidelines.md`
  (JetBrains Junie), `.kiro/steering` (Kiro), and `.rules` (Zed) — so `chamba_load_context`
  picks up those editors' rules too. chamba stays editor-agnostic: "supporting" an editor is
  a config snippet + rule detection, no LLM. Docs (README EN/ES, mcp README, landing tabs +
  pills) list the new editors.

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

## 0.15.0

### Minor Changes

- Tier 3 #2: skills/playbooks registry (index-first, no LLM).

  New `chamba_load_skills` tool: reusable conventions live in `.chamba/skills/*.md` (project,
  then `~/.chamba/skills`) with frontmatter `{ name, description, scope? }`. chamba matches the
  task against each skill's `description` and returns the relevant ones **with their body** plus
  the full catalog — the model reads a cheap index and only pulls the playbooks that apply. Zero
  LLM on chamba's side. `/ticket` and `/orq` call it at the start of a task. Ships **empty and
  opt-in** — you and your team fill it over time.

## 0.14.0

### Minor Changes

- Tier 3 #1: design-aware tickets (Figma). Same detect→use→degrade pattern as QA — chamba
  never calls Figma; your editor's Figma MCP does.

  - **planner** adds a `## Design` section for visual tickets (Figma link/screenshots, the
    frames/nodes, breakpoints, states).
  - **implementer** pulls exact tokens/measurements from a Figma MCP when configured, else
    builds from the screenshots + specs — design-accurate, never "pixel-perfect".
  - **qa** adds a visual check: compare the rendered UI to the design reference (Figma MCP +
    browser, or against the screenshots) and report a visual PASS/FAIL.
  - Heuristic reviewer (`chamba_review_plan`, no LLM) warns `missing-design-capture` when a
    plan links Figma but has no `## Design` section.

## 0.13.0

### Minor Changes

- Tier 2: installer rollback + Given/When/Then acceptance criteria.

  **Installer rollback (safe by default).** Before an `install --force` or an `uninstall`,
  `@chamba/claude-extras` now snapshots the state it manages (`~/.claude.json` + the
  installed commands/agents/hooks) under `~/.chamba/backups/`. New command:
  `chamba-install rollback` (restore the newest), `rollback --list`, `rollback <id>`,
  `rollback --pin <id>`. Snapshots dedup by content and the newest 5 (plus pinned) are kept.
  Nothing is destroyed silently — an unwanted overwrite or removal is one command to undo.

  **Given/When/Then acceptance.** The `planner` now writes each `## QA plan` acceptance
  criterion as Given/When/Then (Dado/Cuando/Entonces) — precondition, action, observable
  result — so it's unambiguous to test. The heuristic reviewer (`chamba_review_plan`, no LLM)
  warns `qa-criteria-not-testable` when a QA plan skips that structure.

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

## 0.11.1

## 0.11.0

### Minor Changes

- ea415bf: feat(workspace): detect the auth stack into a robust `## Auth` section

  `chamba_workspace_init` now scans each project's dependencies for auth providers
  (Auth0, Clerk, AWS Cognito, Supabase, Firebase, Auth.js/NextAuth, Okta, WorkOS,
  Kinde, Stytch, Lucia, Passport, JWT libs; plus Python: Authlib, FastAPI Users,
  django-allauth, python-jose/PyJWT) and writes an `## Auth` section to
  `.chamba/workspace.md` listing each provider, the packages that signalled it, and
  which projects use it. When nothing is detected it prompts the human to document
  auth by hand. This is the base the QA co-pilot and planner rely on to know how
  users are provisioned — the qa agent never creates identity-provider users, it
  asks. Heuristic, no LLM. New exported types `AuthFinding` / `ProjectAuth`.

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

- d7208fa: feat(config): model presets — `config preset <budget|balanced|quality|fast>`

  Named model+effort bundles that set every role at once, layered on the existing
  per-role config. `PRESETS` live in `@chamba/core` (validated: every preset covers
  all roles with catalog models). `ConfigStore.setPreset` writes the preset as the
  `defaults` block while preserving per-role overrides and the worktrees policy. New
  CLI verbs `config preset <name>` and `config presets`, plus a preset option in the
  install wizard. `chamba_get_agent_config` picks them up automatically. Still no LLM.

## 0.9.0

### Minor Changes

- a515a71: Save plans to the vault and surface open-in-editor commands.

  - New **`chamba_save_plan`** tool writes a finalized plan to the vault's `plans/` folder (`plans/<date>-<slug>.md`, tagged `[chamba, plan]`), alongside the run summaries that go under `proyectos/`. `VaultWriter` gained an optional `subdir` so both share one writer; `VAULT_PLANS_DIR` is exported from `@chamba/core`.
  - `/ticket` now saves the final plan (after the clarification gate) and `/orq` saves the approved plan — every plan is persisted, not just the end-of-run summary.
  - `/ticket`'s final report now prints two copy-paste commands below the message to open the work: `code <.code-workspace>` for VS Code and `cursor <.code-workspace>` for Cursor (falling back to the worktree directory).

## 0.8.0

### Minor Changes

- 9c0b22f: Add Claude Fable 5 as an opt-in premium model (with honesty caveats) and make the orchestration prompts editor-aware.

  - **Fable 5 in the catalog**: `claude-fable-5` (Anthropic, opt-in — never a default). New optional `ModelInfo` fields (`pricing_note`, `requires_data_retention`, `can_refuse`) + a `modelCaveat()` helper surface its caveats everywhere a role is chosen: the wizard prints an advisory on select, `chamba_get_agent_config`'s hint + `caveat` field carry it, and the generated subagent frontmatter adds a `# ...` comment line. This stops the "chamba is broken" trap where a zero-retention org selects Fable 5 and their editor 400s.
  - **Honest about the effort ceiling**: documented (catalog, README) that chamba's abstract `extreme` maps to `max` on the Anthropic/Claude Code path (it maps to `xhigh` only for OpenAI), so Fable 5's recommended `xhigh` isn't reachable there — a Fable 5 role runs at `high` or `max`.
  - **Editor-capability degrade preamble** added to `/ticket`, `/qa`, `/orq`, `/map`: use the richest orchestration the editor supports (parallel subagents → sequential → inline) and degrade cleanly, without naming any editor primitive. Keeps richer flows Claude-Code-friendly while staying editor-agnostic.
  - **Loop-until-dry** with a hard cap replaces the fixed "max 3 rounds" in the `/ticket` review + verify loops and `/orq` review: loop until a full pass raises zero new blocking issues, or 6 rounds, with explicit dedup so it can't spin re-reporting fixed findings.

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
