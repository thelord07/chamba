# Plan — Tier 1 (doctor · memoria index-first · presets)

> Ideas robadas de [Gentleman-Programming/gentle-ai](https://github.com/Gentleman-Programming/gentle-ai)
> y adaptadas a los principios de chamba (cero LLM, editor-agnóstico, no-destructivo).
> Guardado acá porque el vault de Obsidian no está conectado en este server MCP.

## Secuencia y release
Tres minors secuenciales (build-in-public, "mejores en cada release"):

| Release | Feature | Por qué en ese orden |
|---|---|---|
| **0.10.0** | `chamba_doctor` | Mayor ganancia de onboarding, standalone, ataca el footgun #1 (stdio/logs/config) |
| **0.11.0** | Memoria index-first + dedup | Refuerza "memoria colectiva" de la landing |
| **0.12.0** | Presets de modelo | El más chico, cierra el Tier 1 |

Cada uno: changeset (lockstep bumpea los 4), tests verdes antes de commit, update README + toque a la landing. Publicar requiere OK explícito de Joys.

**Principios (los tres):** cero LLM (determinista), editor-agnóstico (tools MCP + lógica en `@chamba/core`), no-destructivo (doctor read-only; presets solo escriben config; índice aditivo y self-healing).

---

## Feature 1 — `chamba_doctor` (0.10.0)

**Objetivo:** diagnóstico que valida el entorno y dice qué falta. Tool MCP (cualquier editor) + `npx @chamba/mcp doctor` (CLI, cero instalador). Lógica pura en core, inyectada por ports.

**Archivos:**
- `packages/core/src/doctor/doctor.ts` (NEW) — `class Doctor(fs, process, clock)` / `runDoctor(...)`
- `packages/core/src/doctor/doctor.test.ts` (NEW) — MemoryFilesystem + process mock
- `packages/core/src/index.ts` (EDIT) — export
- `packages/mcp/src/tools/doctor.ts` (NEW) — `registerDoctor(server, logger, services)`
- `packages/mcp/src/doctor.test.ts` (NEW) — InMemoryTransport + Client
- `packages/mcp/src/server.ts` (EDIT) — import + registro
- `packages/mcp/src/main.ts` (EDIT) — subcomando `doctor` (early-exit, como `--version`)

**Checks** (✓ / ⚠ / ✗ + acción sugerida):
1. Node ≥ 22 (`node --version`)
2. git presente (`git --version`)
3. Repo git (`git rev-parse --is-inside-work-tree`) → ⚠ si no
4. Workspace: `.chamba/workspace.md` existe → ⚠ si falta (sugiere `workspace_init`)
5. Config válida: `loadConfig` sobre global+proyecto; capas aplicadas + errores de parseo
6. Vault: resuelve path (env / ObsidianDetector), existe + escribible, nº notas → ⚠ si no hay
7. Log dir: `~/.chamba/logs` creable/escribible (el footgun de stdio)
8. Worktrees: `git worktree list`, cuenta + prunables (informativo)

**Salida:** texto con secciones + resumen (`N ok · M warn · K fail`); CLI setea `exitCode=1` si hay ✗ (gate CI). Tool MCP devuelve `structuredContent` con el detalle.
**Nota:** el subcomando corre y sale ANTES de levantar el server stdio (como `--version`), así que puede imprimir a stdout sin violar el gotcha.

---

## Feature 2 — Memoria index-first + dedup (0.11.0)

**Objetivo:** que `recall`/`load_context` no lea todas las notas, y que resúmenes/planes del mismo repo caigan en un slug estable (sin duplicados). Robado de Engram (índice + normalización por git remote).

**Estado actual:** `ContextBuilder.searchNotes()` hace scan recursivo + lee cada archivo (top 5). `projectSlug = slugify(input.projectSlug ?? input.title)`; no hay lectura de git remote.

**2a. Dedup por git remote (fundacional)**
- `packages/core/src/obsidian/note-template.ts` (EDIT) — `slugifyGitRemote(url)`
- `packages/core/src/obsidian/vault-writer.ts` (EDIT) — `WriteNoteInput.projectRemoteUrl?`
- `packages/mcp/src/tools/summarize-to-vault.ts` + `save-plan.ts` (EDIT) — derivar slug del remote (`git remote get-url origin` vía ProcessPort); fallback al title.

**2b. Índice por carpeta**
- `packages/core/src/obsidian/vault-index.ts` (NEW) — render + parse de `INDEX.md` (lista `{title, description, path}`)
- `packages/core/src/obsidian/vault-writer.ts` (EDIT) — upsert de `proyectos/INDEX.md` y `plans/INDEX.md` tras cada write

**2c. Búsqueda index-first (central)**
- `packages/core/src/workspace/context-builder.ts` (EDIT) — `searchNotes` lee INDEX primero, matchea title/description, carga notas completas solo para el top N.
- **Mantenimiento (recomendado): híbrido** — writer actualiza eager; reader reconstruye si falta/está viejo (self-healing, back-compatible con vaults sin índice).

---

## Feature 3 — Presets de modelo (0.12.0)

**Objetivo:** cambiar costo/calidad de todos los roles con un comando, encima del config por-rol existente.

**Estado actual:** 8 roles; `AgentConfig = {model, effort, reasoning_priority}`; config `~/.chamba/config.json`; schema dinámico sobre `AGENT_ROLES`; `get-agent-config` lee el config → presets fluyen solos.

**Archivos:**
- `packages/core/src/config/presets.ts` (NEW) — `PRESETS: Record<PresetName, Record<AgentRole, AgentConfig>>`
- `packages/core/src/config/presets.test.ts` (NEW) — todo preset cubre 8 roles; modelos ∈ catálogo
- `packages/claude-extras/src/config-store.ts` (EDIT) — `setPreset(name)` expande a `defaults`
- `packages/claude-extras/src/config-cli.ts` (EDIT) — `config preset <name>` + `config presets`
- `packages/claude-extras/src/wizard.ts` (EDIT) — ofrecer preset tras "¿usar defaults?"

Se guarda expandiendo al bloque `defaults` (portable, sin tocar schema). `get-agent-config` no se toca.

| Preset | Razonamiento (orch/planner/reviewer/qa/research) | Ejecución (impl/tester) | Summarizer |
|---|---|---|---|
| **budget** | sonnet · medium | haiku · low | haiku · low |
| **balanced** | sonnet · high | sonnet · medium | haiku · low |
| **quality** | opus · high (planner extreme) | sonnet · medium | haiku · low |
| **fast** | sonnet · low · speed | haiku · low · speed | haiku · low |

`budget` = mínimo costo (mantiene medium en razonamiento); `fast` = mínima latencia (effort low + priority speed).

---

## Cross-cutting
- Docs: cada feature actualiza `README.md` + `README.es.md` y toca `docs/index.html`.
- Proceso: `chamba doctor` como gate pre-release; changeset por feature.
