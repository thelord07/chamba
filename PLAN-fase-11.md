# PLAN — Fase 11: Worktrees multi-repo, genéricos y workspace-aware

> **Borrador para revisión.** No es `PLAN.md`. Es la propuesta de Fase 11 en el mismo
> formato y rigor que las fases existentes. Lo revisás, ajustás, y cuando lo apruebes lo
> mergeo como `### Fase 11` en `PLAN.md` (+ fila en la tabla, marcada `🚧 En progreso`).
>
> Estructurada en **5 sub-fases (11.1–11.5)**, ejecutables una a una, tests verdes y commit
> por sub-fase.

---

## Resumen de la fase

Hoy `chamba_create_worktree` es **single-repo**: crea un worktree en
`<repo>/.chamba/worktrees/<task>/<worker>`. Muchos equipos trabajan en un **workspace de
varios repos** (un parent dir con N repos git) y resuelven un ticket creando un worktree
**por cada repo afectado**, con una rama compartida `<prefijo><ticket>`, copiando los
`.env*` ignorados y generando un archivo `.code-workspace`. Esa lógica es **genérica** —
solo cambian los valores por proyecto.

La Fase 11 hace de ese flujo una capacidad de primera clase de chamba, **manejada por
config** y **agnóstica de proyecto**, con arquitectura **híbrida (Opción C)**:

- **Built-in genérico** (default): chamba crea los worktrees multi-repo leyendo un bloque
  `worktrees` del `.chamba/config.json` del workspace + los repos detectados por el scanner.
- **Escape hatch `command`**: si un equipo tiene un script bespoke, configura
  `worktrees.command` y chamba lo **shellea** en vez de usar el built-in.

Decisiones confirmadas: copia de `.env*` **opt-in** por config; generación de
`.code-workspace` **opt-in** por config.

**Principios:** sigue sin llamar LLMs (es mecánico); `@chamba/core` no toca Node APIs (git
vía `ProcessPort`, copia de archivos vía `FilesystemPort`); todo se expone como tools MCP con
schema Zod; el `.code-workspace` es opcional y no acopla chamba a ningún editor.

---

## Lo que se vuelve genérico (mapa desde el script de referencia)

| Script bespoke (ej. finalis) | Config genérica de chamba (`worktrees`) |
|---|---|
| `FINALIS_ROOT` | workspace root (cwd del tool) |
| `ALL_REPOS=(...)` | repos detectados (git) en el workspace, o `worktrees.repos` |
| `FINALIS_WORKTREES=.../WORKTREES` | `worktrees.layout` (`sibling`/`nested`) + `worktrees.root` |
| `BRANCH_PREFIX=ticket/` | `worktrees.branchPrefix` |
| `BASE_BRANCH=main` | `worktrees.baseBranch` |
| `COPY_ENV=true` | `worktrees.copyEnvFiles` (+ `envPruneDirs`) |
| `.code-workspace` | `worktrees.editorWorkspace` |
| reuso local/origin/new | genérico, built-in |
| `git worktree add` por repo | genérico, built-in |

---

## Sub-fase 11.1 — Config y planificación pura (`@chamba/core`)

**Estado:** ⏳ Pendiente

**Goal:** los tipos, schema y la lógica pura (sin IO) que describe *qué* worktrees crear.

**Entregables:**

- `packages/core/src/config/worktrees.ts`
  - ```ts
    type WorktreeLayout = 'sibling' | 'nested';
    interface WorktreeConfig {
      layout: WorktreeLayout;        // default 'sibling' (multi-repo: una carpeta por ticket)
      root: string;                  // sibling: relativo al workspace root (default 'WORKTREES')
                                     // nested: subdir bajo cada repo (default '.chamba/worktrees')
      branchPrefix: string;          // default 'chamba/'
      baseBranch: string;            // default 'main'
      copyEnvFiles: boolean;         // default false
      envPruneDirs: string[];        // default ['node_modules','.git','.next','dist','build','.venv','cdk.out','.aws-sam']
      editorWorkspace: 'code-workspace' | null;  // default null
      repos: string[] | null;        // default null → autodetectar repos git del workspace
      command: string | null;        // escape hatch; si está, chamba shellea esto
    }
    ```
  - `const DEFAULT_WORKTREE_CONFIG: WorktreeConfig`.
  - `resolveWorktreeConfig(file?: ConfigFile['worktrees']): WorktreeConfig` — merge por-campo
    sobre defaults.

- `packages/core/src/config/schema.ts` (extender)
  - Añadir `worktrees: worktreeConfigSchema.optional()` al `configFileSchema` (Zod, `.strict`
    se mantiene). `worktreeConfigSchema` valida layout enum, strings, booleans, arrays.
  - `branchPrefix`/`root` validados como path-safe (sin `..`, sin caracteres raros).

- `packages/core/src/worktree/multi-repo-plan.ts` — **planificación pura, sin IO.**
  - ```ts
    interface WorktreePlanItem {
      repo: string;            // nombre del repo
      repoPath: string;        // ruta absoluta al repo principal
      worktreePath: string;    // ruta absoluta donde irá el worktree
      branch: string;          // <branchPrefix><ticket>
    }
    interface PlanWorktreesInput {
      workspaceRoot: string;
      ticket: string;
      repos: string[];         // nombres de repos ya resueltos
      config: WorktreeConfig;
    }
    function planWorktrees(input): WorktreePlanItem[];
    ```
  - `worktreePathFor(layout, root, workspaceRoot, ticket, repo)`:
    - `sibling` → `<workspaceRoot>/<root>/<ticket>/<repo>`
    - `nested`  → `<workspaceRoot>/<repo>/<root>/<ticket>` (compat con el estilo actual)
  - `buildTicketBranch(prefix, ticket)` → `slugifyForGit`-safe (reusa `branch-naming.ts`).
    Una sola rama por ticket, **compartida** entre repos (no hay `<worker>` acá).
  - `editorWorkspaceContent(items): string` — genera el JSON `.code-workspace`
    (`{ folders: [{ path: '<repo>' }, ...] }`), determinístico, escapando nombres.

- Exports nuevos en el barrel.

**Tests:** `worktrees.test.ts` (defaults + merge por-campo + schema rechaza layout/ruta
inválida), `multi-repo-plan.test.ts` (paths sibling vs nested; branch con slug; workspace
content JSON válido y estable).

**Acceptance / DoD:** `pnpm --filter @chamba/core test` verde; cero IO en estos módulos;
biome limpio. Commit: `feat(core): multi-repo worktree config + pure planning`.

---

## Sub-fase 11.2 — Creación multi-repo sobre los ports (`@chamba/core`)

**Estado:** ⏳ Pendiente

**Goal:** ejecutar el plan: crear los worktrees con git, copiar `.env`, escribir el archivo
de workspace — todo detrás de `ProcessPort` (git) y `FilesystemPort` (archivos).

**Entregables:**

- `packages/core/src/worktree/git-repo-detector.ts`
  - `detectGitRepos(fs, workspaceRoot): Promise<string[]>` — subdirectorios inmediatos del
    workspace que son repos git (tienen `.git` como **directorio**; un `.git`-archivo es un
    worktree linkeado y se ignora, consistente con el fix del scanner 0.2.1).

- `packages/core/src/worktree/multi-repo-manager.ts`
  - `class MultiRepoWorktreeManager` (constructor: `ProcessPort`, `FilesystemPort`).
  - `create(plan: WorktreePlanItem[], opts): Promise<MultiRepoResult>`:
    - Por cada item, reproduce la lógica del script de referencia con git vía `ProcessPort`:
      1. Si `worktreePath` ya existe → `status: 'skipped-exists'`.
      2. Si la rama existe local (`git show-ref --verify refs/heads/<branch>`) → `worktree add <path> <branch>` (`status: 'reused-local'`).
      3. Si existe en origin (`git ls-remote --heads origin <branch>`) → `fetch` + `worktree add` (`status: 'reused-remote'`).
      4. Si no → `worktree add -b <branch> <path> origin/<baseBranch>` (`status: 'created'`).
    - Si `copyEnvFiles`: copiar `.env*` ignorados de `repoPath` → `worktreePath`
      preservando rutas relativas, podando `envPruneDirs`. Excluir `*.example/*.sample/*.bak`.
    - Devuelve por repo `{ repo, branch, worktreePath, status, envCopied }`.
  - `cleanup(items, opts): Promise<...>` — `git worktree remove` por repo **sin `--force`**,
    **conserva las ramas**, devuelve sugerencias de `git merge --no-ff` por repo (misma
    garantía de seguridad que el `WorktreeManager` actual).
  - Errores como `WorktreeError` (reusa la clase existente).

- `packages/core/src/worktree/env-copy.ts`
  - `copyEnvFiles(fs, src, dst, pruneDirs): Promise<number>` — walk recursivo sobre
    `FilesystemPort`, copia archivos `.env`/`.env.*` (no example/sample/bak), devuelve cuántos.

- `packages/core/src/worktree/editor-workspace.ts`
  - `writeEditorWorkspace(fs, dir, items): Promise<string>` — escribe `<dir>/<ticket>.code-workspace`.

**Tests:** `multi-repo-manager.test.ts` con `FakeProcess` (programar respuestas de git por
comando) + `MemoryFilesystem`: cubre los 4 caminos de rama (new/local/remote/exists), que
`add` recibe los args correctos, que `cleanup` nunca usa `--force` ni borra ramas.
`env-copy.test.ts` (copia preservando rutas, poda node_modules, ignora `.env.example`).
`git-repo-detector.test.ts` (detecta repos hijos, ignora worktrees linkeados y no-git).

**Acceptance / DoD:** tests verdes; ningún import de `node:*` en core; `cleanup` sin
`--force` verificado por test. Commit: `feat(core): multi-repo worktree manager + env copy`.

---

## Sub-fase 11.3 — Tools MCP `chamba_create_worktrees` / `chamba_cleanup_worktrees`

**Estado:** ⏳ Pendiente

**Goal:** exponer el flujo multi-repo como tools, con el **híbrido** built-in/command.

**Entregables:**

- `packages/mcp/src/tools/create-worktrees.ts` (tool #14, plural)
  - Input: `{ ticket: string, repos?: string[] }`.
  - Carga el `.chamba/config.json` (global + project) y resuelve `worktrees` config.
  - **Si `worktrees.command` está set** → ejecuta ese comando vía `ProcessPort`
    (sustituyendo `{ticket}` y `{repos}`), reporta exit code + stdout. (escape hatch)
  - **Si no** → resuelve repos (`repos` arg → `config.repos` → `detectGitRepos`), arma el
    plan con `planWorktrees`, lo ejecuta con `MultiRepoWorktreeManager.create`, y si
    `editorWorkspace` está set escribe el `.code-workspace`.
  - Output estructurado: `{ ticket, branch, layout, worktrees: [{repo, path, branch, status, envCopied}], workspaceFile?, usedCommand? }`.
  - Solo crea; nunca mergea ni borra.

- `packages/mcp/src/tools/cleanup-worktrees.ts` (tool #15, plural)
  - Input: `{ ticket: string, repos?: string[] }`.
  - Quita los worktrees del ticket en cada repo (sin `--force`), **conserva ramas**,
    devuelve los comandos de merge sugeridos.

- Registrar ambas en `server.ts` (las single-repo `chamba_create_worktree` /
  `chamba_cleanup_worktree` **se mantienen** para casos simples).
- Actualizar la tabla de Tools del README (EN/ES) — 15 tools.

**Tests:** `create-worktrees.test.ts` (`InMemoryTransport` + `Client` + `FakeProcess`):
built-in crea N repos; `command` override se ejecuta; sin config usa defaults +
autodetección; output shape. `cleanup-worktrees.test.ts`. Actualizar el assert de conteo de
tools en `server.test.ts` (15).

**Acceptance / DoD:** smoke con MCP Inspector de `chamba_create_worktrees`; aparece en
`npx @chamba/mcp`. Commit: `feat(mcp): multi-repo worktree tools (create/cleanup)`.

---

## Sub-fase 11.4 — Slash command `/ticket` (orchestrator-worker) + `planner` agent + `chamba-config`

**Estado:** ⏳ Pendiente

**Goal:** la UX genérica del flujo completo en Claude Code, **con delegación explícita a los
subagents configurados** (para que la config de modelo+effort de la Fase 10 se aplique de
verdad), y poder configurar `worktrees` sin editar JSON a mano.

**Cómo se conecta con la Fase 10 (importante):** un slash command lo ejecuta la **sesión
principal** (el orchestrator). Los subagents solo corren con su `model`+`effort` configurado
**cuando el orchestrator delega** vía la Task tool. Por eso `/ticket` debe **instruir la
delegación explícitamente**, si no el modelo principal hace todo inline y la config no se
ejercita. El orchestrator sigue siendo la sesión principal (su modelo = el de tu sesión
Claude Code, seteable con `/model`); el entry `orchestrator` del config queda como hint.

**Entregables:**

- `packages/claude-extras/assets/agents/planner.md` — **nuevo subagent** (hoy solo existen
  implementer/reviewer/tester). El orchestrator le delega "generá el plan detallado" y corre
  con el modelo configurado (default `claude-opus-4-8` / `max`). System prompt: descompone el
  ticket en subtareas por repo, define criterios de aceptación, riesgos, archivos.

- `packages/claude-extras/src/agent-frontmatter.ts` (extender) — añadir
  `'planner.md': 'planner'` a `AGENT_ROLE_BY_FILE`, para que `apply` le inyecte el frontmatter
  `model`+`effort` del rol `planner`. (Los otros 4 roles sin archivo siguen como hints.)

- `packages/claude-extras/assets/commands/ticket.md` — slash command **genérico** (cero
  finalis) con **flujo orchestrator-worker explícito** y **un solo gate al final** (corre de
  corrido, parás solo para revisar al terminar):
  1. Crea los worktrees multi-repo vía `chamba_create_worktrees`.
  2. `chamba_load_context` (workspace + Obsidian).
  3. **Delega al subagent `planner`** para el plan detallado; luego `chamba_review_plan`
     (heurístico) **y delega al subagent `reviewer`** para la auditoría. Corrige hasta
     aprobar — **sin parar a pedir OK** (el reviewer heurístico + el reviewer agent son el
     control de calidad antes de ejecutar).
  4. **Por cada subtarea/repo: delega al subagent `implementer`**; los tests **al subagent
     `tester`** — siempre dentro de los worktrees, nunca en los checkouts principales. Corre
     los tests.
  5. `chamba_summarize_to_vault` con el resumen de lo hecho.
  6. **NO commitea, NO mergea, NO hace push.** Deja los cambios en el worktree **sin
     commitear**, sobre la rama del ticket, y **para acá** para que revises. Reporta: qué
     cambió por repo, resultado de los tests, el `.code-workspace` para abrir, y los comandos
     de commit/merge sugeridos para que los corras vos.

- `packages/claude-extras/assets/commands/orq.md` (actualizar) — mismo cambio: delegación
  explícita a planner/reviewer/implementer/tester (hoy lo hace todo inline).

- `packages/claude-extras/src/config-cli.ts` (extender) — subcomando
  `config worktrees` que imprime/edita el bloque `worktrees`, y un `config worktrees init`
  que escribe un bloque de ejemplo en `~/.chamba/config.json` o `./.chamba/config.json`
  (interactivo opcional vía inquirer: layout, root, branchPrefix, copyEnv, editorWorkspace).

- El installer ya copia `assets/commands/*` y `assets/agents/*` → `ticket.md` y `planner.md`
  se instalan/regeneran solos (planner con su frontmatter desde config).

**Tests:** `agent-frontmatter.test.ts` / `installer.test.ts` (extender) — `planner.md` se
renderiza con `model`+`effort` del rol planner; `apply` lo incluye (4 subagents ahora).
`config-cli.test.ts` (extender) para `worktrees init/show` (testeable, sin TTY). Los
`/ticket` y `/orq` son assets markdown (no testeables unitariamente, igual que el resto).

**Acceptance / DoD:** `npx @chamba/claude-extras install` instala `/ticket` + el subagent
`planner` con su modelo configurado; `config worktrees show` refleja el bloque resuelto;
`config apply` regenera 4 subagents. Commit:
`feat(claude-extras): /ticket orchestrator-worker + planner agent + worktrees config CLI`.

---

## Sub-fase 11.5 — Docs + changeset + cierre

**Estado:** ⏳ Pendiente

**Goal:** documentar el flujo multi-repo genérico y cerrar la fase.

**Entregables:**

- README raíz (EN/ES): sección "Multi-repo worktrees" — el bloque `worktrees` de config, el
  flujo `/ticket`, layout sibling vs nested, el híbrido (built-in vs `command`), y un ejemplo
  **genérico** de monorepo-de-repos (presentado como patrón, no como finalis).
- `packages/claude-extras/README.md`: documentar `/ticket` y `config worktrees`.
- **Nota de seguridad** explícita sobre `copyEnvFiles`: copia secretos a los dirs de
  worktree; recomendar que el `worktrees.root` esté gitignored; off por default.
- `examples/`: un `.chamba/config.json` de ejemplo con un bloque `worktrees` (sibling,
  copyEnv, editorWorkspace) y otro con `command` (escape hatch).
- Changeset (minor → **0.3.0**).

**Acceptance / DoD:** `pnpm -r build && pnpm -r test && pnpm biome check .` verde;
changeset registrado; PLAN.md Fase 11 marcada `✅ Completada` (tabla + campo). Commit:
`docs: multi-repo worktrees + close Phase 11`.

---

## Acceptance criteria de la Fase 11 (global)

```bash
pnpm -r build && pnpm -r test && pnpm biome check .

# Built-in: workspace con 3 repos git, config sibling + copyEnv + editorWorkspace
#   (probado con FakeProcess en tests; manual con un parent dir real de repos)
npx @modelcontextprotocol/inspector --cli node packages/mcp/dist/main.js \
  --method tools/call --tool-name chamba_create_worktrees \
  --tool-arg ticket=TICKET-123
# → crea <workspaceRoot>/WORKTREES/TICKET-123/<repo> por cada repo, rama <prefijo>TICKET-123,
#   .env copiados, TICKET-123.code-workspace escrito; status por repo

# Escape hatch: con worktrees.command set, chamba shellea el script del equipo

# Cleanup: quita los dirs de worktree del ticket, conserva ramas, sugiere merge
```

## DoD de la Fase 11

- [ ] core: config `worktrees` (tipos+schema+defaults+resolve), planificación pura, manager
      multi-repo sobre ports, copia `.env`, `.code-workspace`. Tests verdes, cero Node APIs.
- [ ] mcp: `chamba_create_worktrees` + `chamba_cleanup_worktrees` (15 tools), híbrido
      built-in/command. Tests verdes.
- [ ] claude-extras: `/ticket` genérico con **delegación explícita** a subagents; nuevo
      subagent `planner.md` (rol mapeado en `AGENT_ROLE_BY_FILE`, frontmatter desde config);
      `/orq` actualizado igual; `config worktrees`. Tests verdes (4 subagents en `apply`).
- [ ] Edge cases: repo inexistente → skip; worktree ya existe → skip; rama local/origin/new;
      `command` override; `copyEnvFiles` off por default; cleanup sin `--force`, ramas vivas.
- [ ] Docs (multi-repo + nota de seguridad de `.env`), changeset, biome limpio.

---

## Decisiones de diseño tomadas (y por qué)

1. **Tools nuevas plural, las single-repo se mantienen.** `chamba_create_worktree` (single)
   sigue para casos simples; `chamba_create_worktrees` (multi) para el flujo de ticket.
   No rompemos nada. Tool count 13 → 15.
2. **Una rama por ticket, compartida entre repos** (`<branchPrefix><ticket>`), como el script
   de referencia — no el `<worker>` del modelo single-repo. Coherente con "un ticket = una
   feature cross-repo".
3. **Híbrido (Opción C).** Built-in genérico por config como default; `worktrees.command`
   como escape hatch para scripts bespoke. Migración suave: empezás con `command` (tu script)
   y pasás a config cuando quieras.
4. **Layout `sibling` por default en multi-repo** (`<workspaceRoot>/<root>/<ticket>/<repo>`),
   porque agrupa todos los repos de un ticket en una carpeta — el patrón natural multi-repo.
   `nested` queda disponible para quien prefiera worktrees dentro de cada repo.
5. **`copyEnvFiles` y `editorWorkspace` opt-in** (off por default). Copiar `.env` mueve
   secretos: se documenta y se recomienda gitignorear el worktree root.
6. **Repos autodetectados desde el workspace** (subdirs con `.git` directorio), con override
   `worktrees.repos`. Aprovecha que chamba ya es workspace-aware; ignora worktrees linkeados
   (consistente con el fix 0.2.1).
7. **Reusa el sistema de config de la Fase 10.** El bloque `worktrees` vive en el mismo
   `.chamba/config.json`, mismo loader (global ← project), misma validación Zod.
8. **`/ticket` delega explícitamente a los subagents** (planner/reviewer/implementer/tester)
   para que la config de modelo+effort de la Fase 10 se aplique de verdad. Se agrega el
   subagent `planner.md` (no existía); el orchestrator sigue siendo la sesión principal (su
   modelo se setea con `/model`, no por config). `/orq` se actualiza con el mismo patrón.
9. **`/ticket` corre de corrido con un solo gate al final.** Plan→review→implementación→tests
   sin parar a pedir OK (el reviewer heurístico + el reviewer agent son el control antes de
   ejecutar); para solo al final para tu revisión. **No commitea, no mergea, no hace push** —
   deja los cambios en el worktree sin commitear, sobre la rama del ticket, y te da los
   comandos de commit/merge para que los corras vos. (`/orq`, más general, conserva su gate
   tras el plan.)
10. **Ejecución en la misma sesión, no en un Cursor aparte.** El implementer/tester editan
    por ruta absoluta dentro del worktree; el hook `PostToolUse-validate-worktree` ya impide
    tocar fuera del worktree asignado. No hay copy-paste del plan ni transferencia de
    contexto. Ejecución headless/background real es de Claude Code, no de chamba.

## Preguntas abiertas — RESUELTAS

1. **Default de `worktrees.root`** → **`WORKTREES`** (visible, como la convención del equipo).
2. **`chamba_cleanup_worktrees`** → **en V1** (cierra el ciclo crear→probar→limpiar).
3. **`config worktrees init`** → **wizard interactivo** (inquirer): pregunta layout, root,
   branchPrefix, baseBranch, copyEnvFiles, editorWorkspace y escribe el bloque.

**Nota:** como `worktrees.root` por default es `WORKTREES` (visible y versionado), la doc
debe recomendar agregar `WORKTREES/` al `.gitignore` del workspace cuando `copyEnvFiles`
esté activo (evita commitear secretos copiados). El wizard puede ofrecer hacerlo.

## Resumen ejecutivo

- **5 sub-fases (11.1–11.5):** core puro (config+plan) → core manager sobre ports → tools MCP
  → `/ticket` + CLI → docs.
- **Híbrido:** built-in genérico manejado por `.chamba/config.json` + escape hatch `command`.
- **Genérico de verdad:** toda la especificidad de un proyecto (repos, root, prefijo, base,
  env, workspace file) es config; el `/ticket` y las tools no mencionan ningún proyecto.
- **Reusa Fase 10:** mismo `.chamba/config.json`, loader y validación.
- **Seguridad:** copia de `.env` opt-in y documentada; cleanup nunca borra ramas ni usa
  `--force`.
- **3 preguntas abiertas** (default de `root`, cleanup en V1, wizard de `config worktrees`).
- Release objetivo: **0.3.0** (feature minor).
