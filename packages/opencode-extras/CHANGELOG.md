# @chamba/opencode-extras

## 1.11.0

### Patch Changes

- Updated dependencies [b5cbb5a]
- Updated dependencies [5bf4cfb]
  - @chamba/core@1.11.0
  - @chamba/adapters@1.11.0

## 1.10.0

### Minor Changes

- 90fda11: CHAMBA-012: performance and concurrency awareness in all four core agents (planner, implementer, reviewer, tester). Agents now consider N+1 data access, unbounded memory/concurrency, timeouts, idempotency, and hot paths by default, without optimizing prematurely. Adds example skills for Knex+PostgreSQL, NestJS concurrency, and React Native performance in `examples/skills/`.
- e86acd9: PARCHE-010: `/parche` command and vault link/unlink/resync tools. Adds `chamba_vault_link`, `chamba_vault_unlink`, `chamba_vault_resync` MCP tools; `scope` parameter to `chamba_vault_join`; `movedToTrashEntries` to `SyncSummary`; binding header in `chamba_parche_status` and `chamba_vault_status`; `pendingJoinCodeHash` in sync state for safe join resume; `clearPendingAdoption`/`pendingJoinCodeHashOf` helpers; shared `binding-ops.ts` orchestration module; `vault resync` CLI subcommand; and the `/parche` slash command for all editors.

  **Upgrade desde 1.9.0 o anterior:** los vaults pendientes de confirmar creados por esas versiones se confirman con `chamba_vault_link` o `npx @chamba/mcp vault link <slug> --dir <dir> --yes`.

### Patch Changes

- Updated dependencies [adb366b]
- Updated dependencies [e86acd9]
- Updated dependencies [9af9555]
  - @chamba/core@1.10.0
  - @chamba/adapters@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies [375d9c6]
  - @chamba/core@1.9.0
  - @chamba/adapters@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies [35bebe3]
  - @chamba/core@1.8.0
  - @chamba/adapters@1.8.0

## 1.7.0

### Patch Changes

- Updated dependencies [6825d68]
  - @chamba/core@1.7.0
  - @chamba/adapters@1.7.0

## 1.6.0

### Minor Changes

- Per-repo base branches. `worktrees.baseBranch` now accepts either a single branch
  (applied to every repo, as before) or a per-repo map keyed by repo name with an
  optional `"*"` fallback, e.g. `{ "delivery-app": "main", "ms-delivery": "develop", "*": "main" }`.

  `create_worktrees` forks each repo from its own base, and `conflict_preview`,
  `worktree_status`, `list_worktrees` and `partition` compare each repo against its
  real base branch. Backward compatible (a string keeps working), no LLM.

### Patch Changes

- Updated dependencies
  - @chamba/core@1.6.0
  - @chamba/adapters@1.6.0

## 1.5.0

### Minor Changes

- 70f3cce: Safe parallelism 2.0: worktree status + file overlap, merge-tree conflict preview (never merges), partition waves, and opt-in per-worktree PORT in `.env.local`.

### Patch Changes

- Updated dependencies [70f3cce]
  - @chamba/core@1.5.0
  - @chamba/adapters@1.5.0

## 1.4.0

### Patch Changes

- @chamba/adapters@1.4.0
- @chamba/core@1.4.0

## 1.3.0

### Minor Changes

- feat(opencode): new @chamba/opencode-extras — slash commands + subagents for OpenCode

  chamba's editor extras now cover **OpenCode**, not just Claude Code. A new package
  installs the same commands and subagents into OpenCode and registers the MCP server.

  - `npx @chamba/opencode-extras install` writes the commands to
    `~/.config/opencode/commands/`, the subagents to `~/.config/opencode/agents/`
    (`mode: subagent`), and adds `chamba` under `"mcp"` in `opencode.json` (preserving
    any others). `--global`, `--force` and `uninstall` supported.
  - **Shared prompts, one source.** The command/agent bodies are the same files
    `@chamba/claude-extras` ships (copied at build time), translated to OpenCode's format:
    `argument-hint` dropped, agents get `mode: subagent` and a provider-scoped model
    (`anthropic/<id>`) from your `~/.chamba/config.json` reparto; non-Anthropic models are
    left unset so OpenCode uses its default; `effort` is dropped.
  - Docs: package README + updated OpenCode setup guide.

### Patch Changes

- @chamba/adapters@1.3.0
- @chamba/core@1.3.0
