# @chamba/claude-extras

## 0.11.0

### Patch Changes

- 0dd58f7: fix(safety): no chamba agent deletes data without explicit confirmation

  Hardens the guardrail after a QA run could wipe a local DB:

  - **All five agents** (planner, implementer, reviewer, tester, qa) now carry a
    hard rule: never drop/reset/truncate a database, delete files/data, force-push,
    delete branches, or remove container/cloud resources without the human's explicit
    confirmation — STOP and ask first. The planner must gate destructive steps; the
    reviewer flags any ungated destructive op as blocking.
  - The **qa** agent's seed must be additive and non-destructive — never reset/drop/
    recreate the DB to seed it.
  - The **PreToolUse destructive-command hook** now also ASKs on database wipes
    (`prisma migrate reset`, `db push --force-reset`/`--accept-data-loss`,
    `DROP`/`TRUNCATE`, `dropdb`, `db:reset`/`db:drop`/`schema:drop`) plus more
    filesystem/git/container deletions (`rm -r`/`-f`, `git clean`, `git branch -d`,
    `docker … down -v`, `docker volume rm`, `docker system prune`). It asks, never
    hard-blocks — a human yes/no.

- c098bf5: fix(qa): the qa agent co-pilots instead of auto-driving

  The acceptance-QA agent is now explicitly a **co-pilot**, not an autopilot:

  - **Doesn't create identity-provider users.** It detects the auth system
    (Auth0/Firebase/Cognito/Clerk/Supabase/…) and asks the human to provision or
    confirm the needed users+roles, instead of trying to create them. It still
    applies the local **data** seed itself (DB rows/fixtures are separate from identity).
  - **Login is always the human's step.** It opens the browser and pauses for the
    human to log in — never automates credentials (SSO/2FA/Auth0/Firebase break that).
  - **Multi-user flows.** When a criterion needs a different user/role, it pauses and
    asks the human to re-log in as that actor, then continues.

  Updated `qa.md`, the planner's `## QA plan` guidance, and the `/ticket` + `/qa`
  command steps to match.

- Updated dependencies [ea415bf]
  - @chamba/core@0.11.0
  - @chamba/adapters@0.11.0

## 0.10.0

### Minor Changes

- d7208fa: feat(config): model presets — `config preset <budget|balanced|quality|fast>`

  Named model+effort bundles that set every role at once, layered on the existing
  per-role config. `PRESETS` live in `@chamba/core` (validated: every preset covers
  all roles with catalog models). `ConfigStore.setPreset` writes the preset as the
  `defaults` block while preserving per-role overrides and the worktrees policy. New
  CLI verbs `config preset <name>` and `config presets`, plus a preset option in the
  install wizard. `chamba_get_agent_config` picks them up automatically. Still no LLM.

### Patch Changes

- Updated dependencies [64ce3be]
- Updated dependencies [ddd5298]
- Updated dependencies [d7208fa]
  - @chamba/core@0.10.0
  - @chamba/adapters@0.10.0

## 0.9.0

### Patch Changes

- a515a71: Save plans to the vault and surface open-in-editor commands.

  - New **`chamba_save_plan`** tool writes a finalized plan to the vault's `plans/` folder (`plans/<date>-<slug>.md`, tagged `[chamba, plan]`), alongside the run summaries that go under `proyectos/`. `VaultWriter` gained an optional `subdir` so both share one writer; `VAULT_PLANS_DIR` is exported from `@chamba/core`.
  - `/ticket` now saves the final plan (after the clarification gate) and `/orq` saves the approved plan — every plan is persisted, not just the end-of-run summary.
  - `/ticket`'s final report now prints two copy-paste commands below the message to open the work: `code <.code-workspace>` for VS Code and `cursor <.code-workspace>` for Cursor (falling back to the worktree directory).

- Updated dependencies [a515a71]
  - @chamba/core@0.9.0
  - @chamba/adapters@0.9.0

## 0.8.0

### Minor Changes

- 9c0b22f: Add Claude Fable 5 as an opt-in premium model (with honesty caveats) and make the orchestration prompts editor-aware.

  - **Fable 5 in the catalog**: `claude-fable-5` (Anthropic, opt-in — never a default). New optional `ModelInfo` fields (`pricing_note`, `requires_data_retention`, `can_refuse`) + a `modelCaveat()` helper surface its caveats everywhere a role is chosen: the wizard prints an advisory on select, `chamba_get_agent_config`'s hint + `caveat` field carry it, and the generated subagent frontmatter adds a `# ...` comment line. This stops the "chamba is broken" trap where a zero-retention org selects Fable 5 and their editor 400s.
  - **Honest about the effort ceiling**: documented (catalog, README) that chamba's abstract `extreme` maps to `max` on the Anthropic/Claude Code path (it maps to `xhigh` only for OpenAI), so Fable 5's recommended `xhigh` isn't reachable there — a Fable 5 role runs at `high` or `max`.
  - **Editor-capability degrade preamble** added to `/ticket`, `/qa`, `/orq`, `/map`: use the richest orchestration the editor supports (parallel subagents → sequential → inline) and degrade cleanly, without naming any editor primitive. Keeps richer flows Claude-Code-friendly while staying editor-agnostic.
  - **Loop-until-dry** with a hard cap replaces the fixed "max 3 rounds" in the `/ticket` review + verify loops and `/orq` review: loop until a full pass raises zero new blocking issues, or 6 rounds, with explicit dedup so it can't spin re-reporting fixed findings.

### Patch Changes

- Updated dependencies [9c0b22f]
  - @chamba/core@0.8.0
  - @chamba/adapters@0.8.0

## 0.7.0

### Minor Changes

- 4ec6bda: Add an acceptance-QA phase: a `qa` agent that validates a ticket's acceptance criteria against the running app.

  - New configurable `qa` role (`@chamba/core`): default `claude-opus-4-7` / high effort. It shows up in `config show`, the wizard, and `chamba_get_agent_config` automatically.
  - The **planner** now emits a `## QA plan` for user-facing tickets — local seed, test users, URLs, login steps, and the expected behaviour per acceptance criterion. `validatePlan` warns (`missing-qa-plan`, non-blocking) when a user-facing plan lacks one.
  - New **qa** subagent: it adapts to the project — if the repo has Playwright/Cypress (or a browser MCP) it drives the browser; otherwise it runs the repos from the worktree, applies the local seed, and co-pilots with you (asks you to log in, tells you what to click) while validating each criterion. Reports PASS/FAIL, never commits.
  - `/ticket` runs the QA phase after verify when the plan has a `## QA plan`, and folds PASS/FAIL into the final acceptance-criteria checklist. New standalone `/qa <ticket>` command to run or re-run QA on its own.

### Patch Changes

- Updated dependencies [4ec6bda]
  - @chamba/core@0.7.0
  - @chamba/adapters@0.7.0

## 0.6.2

### Patch Changes

- cce6b00: New `/map` command: bootstrap the cross-repo architecture into the vault.

  `/map` reads the workspace's repos for their wiring (REST, async/events, shared data, build deps) and writes living vault notes — `Topology.md`, `Data flows.md`, `Domain entities.md` and `repos/<repo>.md` — with stable names so re-runs update in place. It resolves the vault via `chamba_vault_status` (run `/workspace init` first if you don't have one), asks whether to write in English or Spanish (or pass `en`/`es`), and never overwrites a note you edited by hand (only notes marked `source: chamba`). Opt-in and grounded in real code — built for small or new projects where mapping everything is cheap.

  - @chamba/adapters@0.6.2
  - @chamba/core@0.6.2

## 0.6.1

### Patch Changes

- 3f4c9c2: Add a `--version` flag (alias `-v`) to both bins.

  `npx @chamba/claude-extras --version` and `npx @chamba/mcp --version` now print the installed version and exit — handy for confirming which version `npx` actually resolved. The MCP server prints and exits before any protocol starts, so it doesn't interfere with normal stdio startup.

  - @chamba/adapters@0.6.1
  - @chamba/core@0.6.1

## 0.6.0

### Patch Changes

- Updated dependencies [1c9d77d]
  - @chamba/core@0.6.0
  - @chamba/adapters@0.6.0

## 0.5.2

### Patch Changes

- 477bbd5: Add a clarification gate so `/ticket` resolves plan ambiguities before executing instead of guessing.

  - The **planner** now puts genuine forks (scope/behaviour changes, product decisions only the human can make) under a `## Open questions` section instead of silently assuming.
  - `validatePlan` warns (`unresolved-open-questions`, non-blocking) when the plan has an Open questions section with items that aren't marked answered — the signal for the orchestrator to ask.
  - `/ticket` gained a **clarification gate** between review and worktree creation: if the plan has unresolved open questions or `needs-approval` items, it asks you in one batch, folds your answers into the plan, and only then executes. Clear plans proceed without pausing. The gate applies to `-p` plans too. This is the one deliberate pause; after it, the flow runs to the end as before.

- Updated dependencies [477bbd5]
  - @chamba/core@0.5.2
  - @chamba/adapters@0.5.2

## 0.5.1

### Patch Changes

- b85bb69: `/ticket` now accepts `-p <plan-path>` (alias `--plan`) to reuse a plan you already wrote instead of regenerating it.

  When `-p` points at an existing file, the orchestrator reads it, skips the planner, and runs only `chamba_review_plan` to sanity-check structure and surface issues — it does not bring in the reviewer subagent to rewrite a plan you already approved. If the path doesn't exist it warns and falls back to generating the plan; without `-p` the flow is unchanged. No core/MCP changes — purely the `/ticket` command asset.

  - @chamba/adapters@0.5.1
  - @chamba/core@0.5.1

## 0.5.0

### Minor Changes

- a3c707a: Catch dead code after deletions and stop the /ticket flow from silently dropping acceptance criteria.

  - `validatePlan` now warns (`deletion-without-orphan-check`) when a plan removes code but never mentions verifying referential closure — orphaned callers or now-unused exports. Heuristic, no LLM, no code-graph: it just routes deletion plans toward the build/typecheck + dead-code check (knip / ts-prune) instead of a token grep that misses orphans whose name doesn't contain the deleted symbol.
  - The `/ticket` command gained a post-implementation **verify** stage: the reviewer subagent audits the real diff (not the plan) for referential closure, and the repo's build / typecheck / lint / dead-code check runs before reporting.
  - `/ticket` autonomy is now bounded by the plan's own gates: items the plan marks `needs-approval` are never acted on autonomously, and the final report must include an acceptance-criteria checklist plus a "Needs your decision" section — an AC can no longer be silently dropped under "run to the end".
  - The reviewer subagent's diff review now explicitly checks backward orphans (dead exports/helpers left by a deletion), not just forward breakage.

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

- 098d15d: `/ticket`: analyze first, then create worktrees only for the repos actually
  touched. The orchestrator now loads context and has the planner identify which
  repos the ticket touches before calling `chamba_create_worktrees` — so running
  `/ticket TICKET-123` with no repos infers them from the ticket + workspace map
  instead of creating a worktree for every repo.
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
