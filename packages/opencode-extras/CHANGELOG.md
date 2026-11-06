# @chamba/opencode-extras

## 1.13.1

### Patch Changes

- f8d3097: /vault: subcomandos en inglés (`/vault init`, `/vault classify`); `iniciar`/`clasificar` quedan como alias deprecados (se eliminan en la próxima minor); `argument-hint` en vault.md.
- Updated dependencies [f8d3097]
  - @chamba/core@1.13.1
  - @chamba/adapters@1.13.1

## 1.13.0

### Minor Changes

- a053b78: CHAMBA-017: navegación de la red de conocimiento en el vault. Nueva tool `chamba_vault_navigate` que recorre el árbol de temas paso a paso — vista raíz (temas de primer nivel, carpetas, conteo sin clasificar), vista de nodo (subtemas, notas directas con `summary`/`keywords`, co-temas) y vista de nota (metadatos, backlinks calculados desde `related` y enlaces `[[…]]`/`(…)`, hermanas del mismo `work_item`, cuerpo opcional recortado a `maxChars`). Resuelve aliases (`crear-cursos` → `lms/cursos/creacion`), rechaza rutas absolutas, `..`, segmentos ocultos y extensiones no-`.md`. Corre `VaultReindexer` (write-only-changed, 2 s budget) antes de responder para auto-reparar derivados desactualizados; no dispara push ni autosync. `chamba_load_context` ahora devuelve `## Mapa del vault` (nodos relevantes + notas puntuadas por `summary`/`keywords`, notas de `work_item` mencionado siempre incluidas, presupuesto ≤ 25 % de `maxTokens`) cuando existe `INDEX.md` raíz chamba-generado; sin él, la salida actual `## Relevant notes` queda byte-idéntica (fallback). Ambas tools exponen `structuredContent` + `outputSchema` (Zod). Prompts actualizados (`agents/planner.md`, `agents/diagnostician.md`, `commands/ticket.md`, `commands/recall.md`, `commands/vault.md`) con la regla "Navega antes de leer": `load_context` → mapa, `chamba_vault_navigate` sobre nodos relevantes bajando a subtemas solo si su descripción aplica, `readBody` solo en notas con `summary`/`keywords` pertinentes, sección `Contexto consultado` en planes y tickets.

### Patch Changes

- Updated dependencies [a053b78]
  - @chamba/core@1.13.0
  - @chamba/adapters@1.13.0

## 1.12.0

### Minor Changes

- b1c5799: CHAMBA-016: hierarchical `tema/…` tags as a knowledge network. Notes carry `temas` (1–5 vocabulary paths), `summary`, `keywords`, `aliases`, `work_item`, and `related` in their frontmatter; a note can belong to several topics without being duplicated. A per-workspace `temas/VOCABULARIO.md` (controlled by the human, never invented by chamba) defines the hierarchy, aliases, and promotion/split thresholds. `buildKnowledgeGraph` derives a navigable network deterministically — root `INDEX.md`, per-node topic hubs (`temas/<path>.md`), `temas/sin-clasificar.md`, `temas/PROPUESTOS.md`, per-folder `INDEX.md`s, and optional Obsidian Bases (`.base` files filtered by `file.hasTag`) — writing only what changed, producing identical bytes on any machine and OS. New tools: `chamba_vault_topics` (bootstrap/apply/list/add/alias/promote with `dryRun:true` by default for apply and promote; `apply` with `dryRun:false` only after explicit user confirmation; `replace:true` required if vocabulary already exists), `chamba_vault_classify` (list unclassified notes paginated 50; apply with `dryRun:true` by default, `dryRun:false` only after confirmation; body preserved byte-for-byte), and `chamba_vault_reindex` (also CLI `vault reindex [--dry-run] [--adopt-manual <folder>…] [--yes]`). On a parche pull, derived files (pattern + `source: chamba` + `generated: true`) are accepted without conflict copies and reindex is scheduled; `VOCABULARIO.md` and note files follow the normal conflict flow. Manual `INDEX.md` files (no `source: chamba`) are never overwritten and are reported in `indicesManualesOmitidos`; the `adoptManual` option (dryRun by default, never automatic) renames them to `INDEX (manual).md` before generating a new one. Prompts (`agents/planner.md`, `commands/ticket.md`, `commands/vault.md`, `commands/orq.md`) updated with knowledge-network guidance: read closest nodes before choosing `temas`, several topics → one note, `summary` describes the content, `keywords` for search, `workItem` for HU grouping, unknown topics as proposals.

### Patch Changes

- Updated dependencies [b1c5799]
  - @chamba/core@1.12.0
  - @chamba/adapters@1.12.0

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
