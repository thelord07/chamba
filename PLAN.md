# PLAN — Construcción de **chamba**

> **Cómo usar este documento**
> Este es el plan maestro para construir `chamba`, un MCP server open-source que añade capacidades de orchestrator-worker, workspace-awareness, git worktrees y Obsidian integration a cualquier editor compatible con MCP (Claude Code, Cursor, VS Code con Copilot, Windsurf, Cline, OpenCode, JetBrains, Trae). Está escrito para que **Claude Code lo ejecute por fases**, con verification gates entre cada una. Los bloques `> Claude Code:` son instrucciones directas para la sesión de Claude Code.
>
> **Flujo de uso recomendado:**
> 1. Crea un repo público vacío en GitHub llamado `chamba`.
> 2. Commitea este `PLAN.md` y el `CLAUDE.md`.
> 3. Abre Claude Code en el repo. Dile: *"Lee PLAN.md y CLAUDE.md. Confirma alcance y principios. Ejecuta la Fase 1. No avances a Fase 2 hasta que yo apruebe."*
> 4. Al final de cada fase, revisa el commit, corre los acceptance criteria, aprueba o pide ajustes.
> 5. **Claude Code debe actualizar el estado de cada fase** en este `PLAN.md`: cambiar `⏳ Pendiente` a `✅ Completada — {fecha} — commit {sha-corto}`, **y** actualizar la fila correspondiente en la tabla "Estado de las fases". Las dos ubicaciones deben estar siempre sincronizadas.
> 6. Al final de las fases marcadas con 📢, publica el post de LinkedIn sugerido para construir tracción.

---

## Estado de las fases

> **Claude Code:** mantén esta tabla actualizada. Cuando empieces una fase, marca `🚧 En progreso`. Cuando termines y commitees, marca `✅ Completada` con fecha y commit SHA corto. Si quedas bloqueado, marca `❌ Bloqueada` y describe brevemente por qué.

| # | Fase | Estado | Fecha | Commit |
|---|---|---|---|---|
| 1 | Bootstrap del monorepo + MCP server mínimo | ✅ Completada | 2026-06-09 | 40b029c |
| 2 | Workspace context + scanner | ✅ Completada | 2026-06-09 | c588a56 |
| 3 | Obsidian integration | ✅ Completada | 2026-06-09 | 37b8595 |
| 4 | Plan generation + reviewer (heurístico) | ⏳ Pendiente | — | — |
| 5 | Worktree manager | ⏳ Pendiente | — | — |
| 6 | Memory store + cross-session context | ⏳ Pendiente | — | — |
| 7 | Claude Code extras (slash commands, subagents, hooks) | ⏳ Pendiente | — | — |
| 8 | Documentación multi-editor + ejemplos | ⏳ Pendiente | — | — |
| 9 | Release 1.0.0 + push de tracción | ⏳ Pendiente | — | — |

**Símbolos:** ⏳ Pendiente — 🚧 En progreso — ✅ Completada — ❌ Bloqueada

---

## 1. Contexto y objetivo

**chamba** es un MCP server open-source en TypeScript. Expone un conjunto coherente de tools que cualquier editor con MCP client puede consumir desde su chat: orchestrator-worker, workspace context, git worktrees, integración Obsidian, plan + review, memory.

**De dónde viene el nombre.** "Chamba" es la palabra coloquial latina para *trabajo*. El nombre es personalidad LATAM intencional como punto diferenciador frente a las herramientas gringas.

**Inspirado por** byo-coding-agent (BettaTech) en lo conceptual, lapzo-tools en el patrón MCP. No reemplaza a ninguno; añade un conjunto de capacidades de orquestación que hoy no existen empaquetadas de esta forma.

**Por qué construirlo así (y no como harness propio):**

- chamba **no llama al LLM**. Eso lo hace el editor del usuario (Cursor con su modelo, Claude Code con la suscripción Max del usuario, VS Code con Copilot, etc.).
- chamba solo expone **tools y patterns**: escanear workspaces, generar planes, validarlos, crear worktrees, escribir resúmenes al vault de Obsidian, etc.
- Esto elimina el problema de la API key — el editor paga su propio modelo.
- Una sola implementación funciona en **todos los editores compatibles con MCP** desde el día uno.

**Para qué lo construyo:**
- Base reutilizable entre mis side projects (VoxCash, fixbody.app, futuros experimentos).
- Material para mi contenido en LinkedIn — cada fase es un post natural en "Deploy on Friday 🔥" y #MenteDeDesarrollador.
- Vehículo para encontrar tracción en GitHub y construir reputación técnica más allá del trabajo de día.

**Done de V1 significa:**
- `npx @chamba/mcp` arranca un MCP server stdio funcional.
- 10+ tools MCP bien diseñadas, schemas claros, documentación por tool.
- Configurable desde Cursor (`.cursor/mcp.json`), Claude Code (`~/.claude.json`), VS Code (`.vscode/mcp.json`), y otros editores compatibles con MCP estándar.
- Workspace-aware: entiende el directorio del usuario y opcionalmente integra con vault de Obsidian.
- Soporta git worktrees para aislamiento de tareas en paralelo.
- Plan + reviewer (heurístico, no LLM) para validar planes antes de ejecutar.
- Extras opcionales para Claude Code (slash commands, subagents pre-configurados, hooks).
- README listo para Hacker News / Reddit / LinkedIn.

---

## 2. Principios de diseño no-negociables

Los **10 principios** que Claude Code no debe romper. Si Claude Code encuentra tensión genuina con alguno, **debe detenerse y preguntar**.

1. **chamba no llama LLMs.** Cero. Ningún archivo del repo importa `@anthropic-ai/sdk` ni `openai` ni equivalente. El razonamiento lo hace el modelo del cliente que invoca las tools MCP. Si Claude Code se encuentra escribiendo una llamada a un modelo, está violando este principio.

2. **MCP server como producto principal.** Todo lo que hacemos se materializa en tools MCP. Si una capacidad no se puede modelar como una tool MCP con schema Zod claro, hay que repensarla antes de implementarla.

3. **Cero API keys requeridas para usar chamba.** El usuario solo necesita un editor con MCP client. No hay variables de entorno tipo `ANTHROPIC_API_KEY` ni `OPENAI_API_KEY` en ningún ejemplo del repo.

4. **Multi-cliente desde el primer commit.** Cualquier tool nueva debe documentar cómo se invoca desde Cursor, Claude Code, VS Code y otros editores. Si solo funciona en uno, repensar.

5. **Tools idempotentes y observables.** Las tools tienen efectos secundarios concretos (escribir archivos, crear worktrees, etc.) pero son idempotentes cuando es posible, y siempre devuelven output estructurado que el modelo cliente puede razonar.

6. **El core (`@chamba/core`) no importa Node-specific APIs** como `fs` o `child_process` directamente. Cualquier capacidad OS-level va detrás de un port/adapter. Esto permite testabilidad y, en el futuro, edge runtime.

7. **Sin frameworks pesados.** Nada de NestJS, nada de LangChain, nada de Mastra. TypeScript puro con dependencias mínimas.

8. **Type-first.** Schemas Zod para todas las tools. Tipos explícitos en contratos públicos. Cero `any` excepto donde sea estrictamente necesario, con justificación.

9. **Tests obligatorios antes de cerrar una fase.** Sin tests verdes no se commitea como completa.

10. **Cada fase termina con algo demoable.** Una tool nueva invocable, una capacidad observable. Nada de "fase de refactorización interna".

---

## 3. Arquitectura objetivo

### Estructura del monorepo

```
chamba/
├── PLAN.md
├── CLAUDE.md
├── README.md                        # Marketing-grade, multi-editor
├── README.es.md
├── CONTRIBUTING.md
├── LICENSE                          # MIT
├── CHANGELOG.md
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── biome.json
├── vitest.config.ts
├── .changeset/
├── .github/workflows/
│   ├── ci.yml
│   └── release.yml
│
├── packages/
│   ├── core/                        # @chamba/core
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── workspace/
│   │   │   │   ├── workspace.ts
│   │   │   │   ├── scanner.ts
│   │   │   │   ├── obsidian-detector.ts
│   │   │   │   └── context-builder.ts
│   │   │   ├── worktree/
│   │   │   │   ├── manager.ts
│   │   │   │   ├── git-detector.ts
│   │   │   │   └── branch-naming.ts
│   │   │   ├── plan/
│   │   │   │   ├── template.ts        # Templates de plan estructurado
│   │   │   │   ├── validator.ts       # Validaciones heurísticas (no LLM)
│   │   │   │   └── reviewer.ts        # Checklist de revisión
│   │   │   ├── obsidian/
│   │   │   │   ├── vault-writer.ts
│   │   │   │   └── note-template.ts
│   │   │   ├── memory/
│   │   │   │   ├── store.ts
│   │   │   │   └── filesystem-store.ts
│   │   │   ├── ports/
│   │   │   │   ├── filesystem.ts
│   │   │   │   ├── process.ts
│   │   │   │   └── clock.ts
│   │   │   └── events/
│   │   │       └── emitter.ts
│   │   ├── test/
│   │   └── package.json
│   │
│   ├── adapters/                    # @chamba/adapters — Node impls
│   │   ├── src/
│   │   │   ├── node-filesystem.ts
│   │   │   ├── node-process.ts
│   │   │   └── system-clock.ts
│   │   └── package.json
│   │
│   ├── mcp/                         # @chamba/mcp — el producto principal
│   │   ├── src/
│   │   │   ├── main.ts              # Entry point del MCP server
│   │   │   ├── server.ts            # MCP server setup con @modelcontextprotocol/sdk
│   │   │   ├── tools/
│   │   │   │   ├── index.ts         # Registry de todas las tools
│   │   │   │   ├── workspace-init.ts
│   │   │   │   ├── workspace-show.ts
│   │   │   │   ├── workspace-reload.ts
│   │   │   │   ├── load-context.ts
│   │   │   │   ├── generate-plan.ts
│   │   │   │   ├── review-plan.ts
│   │   │   │   ├── create-worktree.ts
│   │   │   │   ├── list-worktrees.ts
│   │   │   │   ├── cleanup-worktree.ts
│   │   │   │   ├── summarize-to-vault.ts
│   │   │   │   ├── remember.ts
│   │   │   │   └── recall.ts
│   │   │   ├── schemas/             # Zod schemas para inputs/outputs
│   │   │   ├── logging.ts           # pino → archivo, NUNCA stdout
│   │   │   └── config.ts
│   │   ├── bin/
│   │   │   └── chamba-mcp
│   │   └── package.json
│   │
│   └── claude-extras/               # @chamba/claude-extras (opcional)
│       ├── src/
│       │   ├── install.ts           # `chamba install-claude-extras`
│       │   ├── slash-commands/      # /orq, /workspace, /worktrees (markdown)
│       │   ├── subagents/           # implementer.md, reviewer.md, tester.md
│       │   └── hooks/               # PreToolUse, PostToolUse validations
│       ├── bin/
│       │   └── chamba-install
│       └── package.json
│
└── examples/
    ├── cursor-setup/                # .cursor/mcp.json + walkthrough
    ├── claude-code-setup/           # ~/.claude.json + walkthrough
    ├── vscode-setup/                # .vscode/mcp.json + walkthrough
    ├── windsurf-setup/
    ├── opencode-setup/
    └── obsidian-orchestrator/       # Demo end-to-end con vault Obsidian
```

### El directorio `.chamba/` del usuario

Cuando alguien usa chamba en un proyecto, este es el directorio que chamba lee/escribe (vía sus tools MCP, invocadas por el modelo del editor):

```
mi-proyecto/                        # Carpeta del usuario
├── ...código del proyecto...
└── .chamba/                        # Creado por la tool chamba_workspace_init
    ├── workspace.md                # Mapa del workspace (editable a mano)
    ├── plans/                      # Planes generados
    │   └── 2026-06-09-add-health-check.md
    ├── worktrees/                  # Git worktrees activos
    │   └── 2026-06-09-add-health-check/
    │       └── implementer/        # git worktree con rama chamba/...
    └── memory/                     # Notas persistentes entre sesiones
        └── *.md
```

### Tools MCP expuestas en V1 (lista completa)

| Tool | Inputs | Output | LLM? |
|---|---|---|---|
| `chamba_workspace_init` | `{ root?: string }` | `{ created: bool, path: string, contents: string }` | No |
| `chamba_workspace_show` | `{}` | `{ contents: string }` | No |
| `chamba_workspace_reload` | `{}` | `{ diff: string, suggestions: string[] }` | No |
| `chamba_load_context` | `{ task: string, includeObsidian?: bool }` | `{ context: string, relevantNotes?: string[] }` | No |
| `chamba_generate_plan` | `{ task: string, context: string }` | `{ planTemplate: string, suggestedSubtasks: SubtaskSpec[] }` | No |
| `chamba_review_plan` | `{ plan: string, task: string, context: string }` | `{ approved: bool, issues: Issue[], suggestions: string[] }` | No |
| `chamba_create_worktree` | `{ taskSlug: string, workerId: string, baseBranch?: string }` | `{ path: string, branch: string }` | No |
| `chamba_list_worktrees` | `{}` | `{ worktrees: WorktreeHandle[] }` | No |
| `chamba_cleanup_worktree` | `{ branch: string }` | `{ removed: bool, branchKept: bool }` | No |
| `chamba_summarize_to_vault` | `{ title: string, content: string, projectSlug?: string }` | `{ notePath: string }` | No |
| `chamba_remember` | `{ key: string, content: string }` | `{ saved: bool, path: string }` | No |
| `chamba_recall` | `{ query: string }` | `{ matches: Memory[] }` | No |

**Ninguna tool llama a un LLM.** El modelo del cliente las invoca y razona sobre los outputs. Esto es lo que hace que chamba funcione en Cursor, Claude Code, VS Code, etc. sin importar qué modelo use cada uno.

### Cómo se ve el flujo orchestrator-worker desde el editor

```
Usuario en Cursor: "@chamba orchestrate add health check endpoint"
  ↓
Modelo de Cursor recibe el prompt y razona
  ↓
Modelo invoca: chamba_load_context({ task: "add health check..." })
  ↓
chamba lee .chamba/workspace.md + busca notas relevantes → devuelve context
  ↓
Modelo razona y produce un plan inicial
  ↓
Modelo invoca: chamba_review_plan({ plan, task, context })
  ↓
chamba corre validaciones heurísticas (¿menciona acceptance criteria?
  ¿toca solo módulos relevantes? ¿hay riesgo evidente?) → devuelve feedback
  ↓
Modelo ajusta el plan si hay issues
  ↓
Modelo invoca: chamba_create_worktree({ taskSlug, workerId: "implementer" })
  ↓
chamba crea git worktree → devuelve path
  ↓
Modelo cambia su working directory al worktree y trabaja ahí
  (usando SUS tools nativas: edit, bash, etc.)
  ↓
Al terminar, modelo invoca: chamba_summarize_to_vault({ title, content })
  ↓
chamba escribe nota estructurada al vault de Obsidian
  ↓
Resultado final visible para el usuario en el chat de Cursor
```

**chamba aporta:** workspace context, plan validation, worktree isolation, vault writing. **El modelo aporta:** razonamiento, decisión, código. División de responsabilidades limpia.

---

## 4. Stack y dependencias justificadas

| Capa | Dependencia | Versión | Por qué |
|---|---|---|---|
| Build tool | `tsup` | ^8 | Bundle por paquete, dual ESM/CJS, sin config |
| Lint + format | `biome` | ^2 | Una sola dep, 10x más rápido que ESLint+Prettier |
| Tests | `vitest` | ^2 | TS sin transpiler aparte, watch rápido |
| Validación | `zod` | ^3 | Schemas + inferencia de tipos TS |
| Result types | `neverthrow` | ^8 | `Result<T,E>` ergonómico |
| MCP SDK | `@modelcontextprotocol/sdk` | latest | SDK oficial de Anthropic |
| Logging | `pino` | ^9 | Estructurado, rápido, sale a archivo (CRÍTICO en MCP stdio) |
| Workspace | `pnpm` | ^9 | Workspaces nativos eficientes |
| Versionado | `changesets` | ^2 | Estándar para monorepos publicables en npm |

**Lo que NO usamos (lista deliberada):**

- **`@anthropic-ai/sdk`, `openai`, cualquier SDK de LLM.** chamba no llama modelos. Si Claude Code intenta añadir uno, está violando el principio 1.
- **`@modelcontextprotocol/inspector` como dependencia de runtime.** Solo se usa para tests/dev, va en `devDependencies`.
- **LangChain, Mastra, frameworks de agentes.** Innecesarios; el editor del usuario ya es el "framework de agente".
- **Hono, Express, Fastify.** chamba no es un HTTP server. Es un MCP server stdio.
- **Ink, blessed, TUIs.** El editor del usuario ya es la TUI.

**MCP servers de terceros que recomendamos al usuario (no son deps):**

- `obsidian-mcp` para integración profunda con vault (búsqueda semántica de notas).
- Otros MCP servers oficiales según necesite el usuario.

---

## 5. Plan de ejecución por fases

Cada fase tiene:
- **Goal**, **Entregables**, **Acceptance criteria**, **DoD**.
- 📢 marca dónde generar contenido para LinkedIn.

---

### Fase 1 — Bootstrap del monorepo + MCP server mínimo 📢

**Estado:** ✅ Completada — 2026-06-09 — 40b029c

**Goal:** `npx @chamba/mcp` arranca un MCP server con una sola tool funcional (`chamba_workspace_show`), inspeccionable con MCP Inspector. Sin abstracciones, sin layers — el smallest thing that works.

**Entregables:**
- `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `vitest.config.ts`.
- `.gitignore`, `.nvmrc` (Node 22 LTS), `.editorconfig`.
- `LICENSE` (MIT), `CONTRIBUTING.md` mínimo.
- `packages/mcp/src/main.ts` — entry point que arranca server stdio.
- `packages/mcp/src/server.ts` — setup MCP server con `@modelcontextprotocol/sdk`.
- `packages/mcp/src/tools/workspace-show.ts` — primera tool, lee `.chamba/workspace.md` del cwd si existe, devuelve contenido o `null`.
- `packages/mcp/src/logging.ts` — pino configurado para sacar a `~/.chamba/logs/mcp-{pid}.log`. **NUNCA a stdout.**
- `packages/mcp/bin/chamba-mcp` — shebang script invocable.
- `README.md` inicial con quick start (se pule en fases posteriores).

**Acceptance criteria:**
```bash
pnpm install
pnpm biome check .
pnpm --filter @chamba/mcp build

# Verificación con MCP Inspector:
npx @modelcontextprotocol/inspector node packages/mcp/dist/main.js
# Debe mostrar 1 tool: chamba_workspace_show

# Smoke manual:
mkdir /tmp/test && cd /tmp/test
echo "# test workspace" > .chamba/workspace.md
node /path/to/chamba/packages/mcp/dist/main.js < /dev/null
# (en realidad esto requiere stdio handshake; basta con el Inspector)
```

**DoD:**
- El server NO escribe a stdout fuera del protocolo MCP (verificar con grep en logs del Inspector).
- Commit: `feat: bootstrap monorepo + minimal MCP server with workspace_show tool`.

**📢 Post de LinkedIn:** *"Empecé chamba: un MCP server que añade orquestación + workspace context a Cursor, Claude Code y otros editores. Sin API keys, usa el modelo de tu editor. Fase 1: el server arranca y devuelve una tool. La cosa más chiquita que funciona."* Serie: Deploy on Friday 🔥.

---

### Fase 2 — Workspace context + scanner

**Estado:** ✅ Completada — 2026-06-09 — c588a56

**Goal:** las 3 tools de workspace funcionales: init (escanea el dir y genera `workspace.md`), show (ya existe), reload (re-escanea y devuelve diff sin sobrescribir).

**Entregables:**
- `packages/core/src/workspace/workspace.ts` — tipos `Workspace`, `ProjectRef`, loader.
- `packages/core/src/workspace/scanner.ts`:
  - `scan(root)` recorre directorio respetando `.gitignore`.
  - Identifica archivos clave (`README*`, `package.json`, `pyproject.toml`, `Cargo.toml`, etc.).
  - Detecta lenguajes, framework principal, estructura.
  - Genera `workspace.md` con secciones: descripción, convenciones, proyectos activos, mapa.
- `packages/core/src/ports/` — interfaces `FilesystemPort`, `ProcessPort`, `ClockPort`.
- `packages/adapters/src/` — implementaciones Node.
- `packages/mcp/src/tools/workspace-init.ts`:
  - Schema input: `{ root?: string }`.
  - Si `.chamba/workspace.md` ya existe, NO sobrescribe — devuelve `{ alreadyExists: true, currentContents }` para que el modelo decida.
  - Si no existe, escanea y genera.
- `packages/mcp/src/tools/workspace-reload.ts`:
  - Re-escanea el dir actual.
  - Devuelve un diff entre el `workspace.md` actual y el resultado del escaneo. **No sobrescribe.**
  - El modelo decide si actualizar.
- Tests con `FilesystemPort` en memoria para scanner.

**Acceptance criteria:**
```bash
pnpm -r test
npx @modelcontextprotocol/inspector node packages/mcp/dist/main.js
# Debe listar 3 tools: workspace_init, workspace_show, workspace_reload
# Invocar workspace_init en un dir de prueba → debe crear .chamba/workspace.md
```

**DoD:**
- Scanner respeta `.gitignore` y `.dockerignore`. No lee binarios. No lee `node_modules/`.
- `workspace.md` generado es legible y editable a mano.
- Si el usuario lo edita, `reload` NO lo sobrescribe — devuelve diff.
- Commit: `feat(workspace): scanner + init/show/reload tools`.

---

### Fase 3 — Obsidian integration 📢

**Estado:** ✅ Completada — 2026-06-09 — 37b8595

**Goal:** chamba detecta si hay vault Obsidian, inyecta búsqueda contextual en `load_context`, y puede escribir resúmenes estructurados al vault vía `summarize_to_vault`.

**Entregables:**
- `packages/core/src/workspace/obsidian-detector.ts`:
  - Detecta vault buscando `.obsidian/` en `root`, `~/Documents/`, `~/Notes/`, rutas comunes.
  - Permite override vía env var `CHAMBA_OBSIDIAN_VAULT_PATH`.
  - Devuelve `{ found, path?, noteCount? }`.
- `packages/core/src/workspace/context-builder.ts`:
  - `build(workspace, task)` produce bloque markdown con contexto.
  - Si hay vault: busca por keywords del task notas relevantes (búsqueda simple por contenido, no semántica en V1).
  - Limita output a tamaño configurable (default ~2000 tokens estimados).
- `packages/core/src/obsidian/vault-writer.ts`:
  - Crea nota en `vault/proyectos/{fecha}-{slug}.md` con frontmatter YAML estándar.
  - Estructura: título, fecha, tags, resumen, plan, decisiones, archivos tocados, próximos pasos, links.
- `packages/core/src/obsidian/note-template.ts`:
  - Template editable para usuarios que quieran customizar el formato.
- `packages/mcp/src/tools/load-context.ts`:
  - Input: `{ task, includeObsidian? }`.
  - Output: contexto del workspace + (si aplica) notas relevantes.
- `packages/mcp/src/tools/summarize-to-vault.ts`:
  - Input: `{ title, content, projectSlug? }`.
  - Falla con mensaje claro si no hay vault configurado.
- `examples/obsidian-orchestrator/` — demo con vault de prueba.

**Acceptance criteria:**
```bash
pnpm -r test
# Smoke con vault simulado:
CHAMBA_OBSIDIAN_VAULT_PATH=/tmp/test-vault npx @modelcontextprotocol/inspector node packages/mcp/dist/main.js
# Invocar load_context({ task: "auth", includeObsidian: true }) → debe listar notas relevantes
# Invocar summarize_to_vault({ title: "test", content: "..." }) → debe crear nota
```

**DoD:**
- Si no hay vault, `summarize_to_vault` devuelve error claro: `{ error: "No Obsidian vault configured. Set CHAMBA_OBSIDIAN_VAULT_PATH or use the obsidian-mcp server" }`.
- Las notas escritas tienen frontmatter YAML válido (parseable por Obsidian).
- Commit: `feat(obsidian): vault detection, context injection, vault writer`.

**📢 Post de LinkedIn:** *"chamba ahora habla con tu vault de Obsidian. Le pides una tarea desde Cursor, busca contexto en tus notas, y al terminar deja un resumen estructurado de vuelta en el vault. Tu segundo cerebro y tu agente, sincronizados."* Tema: cómo MCP convierte tu vault en memoria persistente para cualquier agente.

---

### Fase 4 — Plan generation + reviewer heurístico

**Estado:** ⏳ Pendiente

**Goal:** tools `generate_plan` y `review_plan`. La generación devuelve un **template estructurado**, no un plan completo (el modelo del cliente lo refina). El reviewer aplica validaciones programáticas heurísticas, no llama LLM.

**Entregables:**
- `packages/core/src/plan/template.ts`:
  - `PlanTemplate` con secciones: goal, acceptance criteria, subtasks (con tipo y worker sugerido), risks, files-likely-touched.
  - Función `generateTemplate(task, context, workspace)` devuelve un template con placeholders que el modelo llena.
- `packages/core/src/plan/validator.ts`:
  - Reglas heurísticas chequeables sin LLM:
    - ¿Tiene acceptance criteria explícitos?
    - ¿Las subtasks tienen worker asignado?
    - ¿Hay subtasks sin descripción concreta?
    - ¿Toca archivos fuera de los módulos mencionados en workspace.md?
    - ¿Hay risk flags evidentes (toca `auth/`, toca `payments/`, toca `database/migrations/`)?
- `packages/core/src/plan/reviewer.ts`:
  - `Reviewer.review(plan, context, task)` → `PlanReview`.
  - Devuelve `{ approved, issues: [], suggestions: [], riskFlags: [] }`.
  - El modelo del cliente recibe esto y decide si re-planea.
- `packages/mcp/src/tools/generate-plan.ts`:
  - Input: `{ task, context }`.
  - Output: template estructurado para que el modelo lo refine.
- `packages/mcp/src/tools/review-plan.ts`:
  - Input: `{ plan, task, context }`.
  - Output: review estructurado.
- Tests con planes de ejemplo (algunos pasan, algunos fallan validaciones específicas).

**Acceptance criteria:**
```bash
pnpm -r test
# Smoke:
# generate_plan({ task: "add health check", context: "..." }) → template con secciones
# review_plan({ plan: "implementar health check sin tests", ... }) → { approved: false, issues: ["no tests mentioned"] }
# review_plan({ plan: "<plan completo y bien estructurado>", ... }) → { approved: true }
```

**DoD:**
- Reviewer detecta al menos 5 anti-patrones diferentes en planes (sin tests, sin acceptance criteria, sin workers asignados, archivos no relacionados, falta de risk assessment).
- Cero llamadas a LLM. Verificable revisando imports de `plan/`.
- Commit: `feat(plan): template generator + heuristic reviewer`.

---

### Fase 5 — Worktree manager 📢

**Estado:** ⏳ Pendiente

**Goal:** tools `create_worktree`, `list_worktrees`, `cleanup_worktree`. Permite a los modelos crear aislamiento real para trabajo en paralelo.

**Entregables:**
- `packages/core/src/worktree/git-detector.ts`:
  - `isGitRepo(root)` con `git rev-parse --is-inside-work-tree`. Cachea por sesión.
- `packages/core/src/worktree/branch-naming.ts`:
  - Convención: `chamba/{YYYY-MM-DD}-{task-slug}/{worker-id}`.
  - Sanitiza para git (lowercase, sin espacios, sin caracteres reservados).
- `packages/core/src/worktree/manager.ts`:
  - `create({ root, taskSlug, workerId, baseBranch })` → crea en `.chamba/worktrees/{taskSlug}/{workerId}/`.
  - `list(root)` → parsea `git worktree list --porcelain`.
  - `cleanup(handle)` → SOLO `git worktree remove` sin `--force`. **NUNCA borra branch ni mergea.**
- `packages/mcp/src/tools/create-worktree.ts`:
  - Si el repo no es git: devuelve `{ error: "Not a git repo, worktree skipped. Worker should use main cwd." }`.
  - Si es git: crea y devuelve handle.
- `packages/mcp/src/tools/list-worktrees.ts`:
  - Devuelve array de handles activos.
- `packages/mcp/src/tools/cleanup-worktree.ts`:
  - Input: `{ branch }`.
  - Borra el dir del worktree pero mantiene la rama.
  - Output: `{ removed: true, branchKept: true, mergeSuggestion: "git merge --no-ff <branch>" }`.

**Acceptance criteria:**
```bash
pnpm -r test
# Smoke en repo git limpio:
# create_worktree({ taskSlug: "test", workerId: "w1" }) → handle con path real
# git branch --list 'chamba/*' → debe mostrar la rama creada
# cleanup_worktree({ branch }) → dir removido, branch sigue existiendo

# Smoke en repo NO git:
# create_worktree({ ... }) → { error: "Not a git repo..." }
```

**DoD:**
- Detección git robusta (verificado con dir git y dir no-git).
- Cleanup NUNCA borra la rama. Verificado con grep en código + test específico.
- Sin `--force` en `git worktree remove` (test con worktree dirty falla limpio).
- Commit: `feat(worktree): manager + 3 tools (create/list/cleanup)`.

**📢 Post de LinkedIn:** *"Mi agente ahora puede trabajar en 3 tareas en paralelo sin pisarse archivos. Cada tarea, su propio git worktree. Cuando termina, las ramas quedan abiertas para que yo decida qué mergear. Aislamiento real, control humano."* Tema: por qué git worktrees + agentes = el patrón que faltaba para paralelismo seguro.

---

### Fase 6 — Memory store + cross-session context

**Estado:** ⏳ Pendiente

**Goal:** tools `remember` y `recall`. El modelo puede persistir conocimiento entre sesiones sin depender de la ventana de contexto.

**Entregables:**
- `packages/core/src/memory/store.ts` — interface `MemoryStore`.
- `packages/core/src/memory/filesystem-store.ts`:
  - Guarda cada memoria como `.chamba/memory/{slug}.md` con frontmatter (key, tags, createdAt).
  - Búsqueda simple: por keyword en contenido y en tags.
- `packages/mcp/src/tools/remember.ts`:
  - Input: `{ key, content, tags? }`.
  - Crea archivo markdown. Si la key existe, append con timestamp.
- `packages/mcp/src/tools/recall.ts`:
  - Input: `{ query }`.
  - Output: array de memorias relevantes con paths y contenido.
- Tests con `FilesystemPort` en memoria.

**Acceptance criteria:**
```bash
pnpm -r test
# Smoke:
# remember({ key: "auth-decisions", content: "We use magic links via Resend" })
# → archivo creado en .chamba/memory/
# recall({ query: "auth" }) → devuelve la memoria anterior
```

**DoD:**
- Memorias son archivos markdown editables a mano (no JSON ni DB).
- Búsqueda funciona case-insensitive y por substring.
- Commit: `feat(memory): filesystem-based store + remember/recall tools`.

---

### Fase 7 — Claude Code extras (slash commands, subagents, hooks) 📢

**Estado:** ⏳ Pendiente

**Goal:** paquete opcional `@chamba/claude-extras` que se instala con `npx @chamba/claude-extras install` y añade slash commands, subagents pre-configurados y hooks a `~/.claude/`. Aprovecha las tools MCP de chamba para dar una experiencia más fluida en Claude Code específicamente.

**Por qué es opcional:** los usuarios de Cursor, VS Code, etc. ya tienen todo lo que necesitan vía MCP. Esto es solo para los que usan Claude Code y quieren atajos.

**Entregables:**
- `packages/claude-extras/src/install.ts`:
  - Detecta si Claude Code está instalado.
  - Copia archivos a `~/.claude/agents/`, `~/.claude/commands/`, `~/.claude/hooks/`.
  - Configura `~/.claude.json` añadiendo chamba como MCP server.
  - **NO sobrescribe** si los archivos existen — pregunta o pide flag `--force`.
- `packages/claude-extras/src/slash-commands/`:
  - `/orq.md` — comando que orquesta una tarea usando las tools de chamba.
  - `/workspace.md` — atajo para workspace_init/show/reload.
  - `/worktrees.md` — lista y limpieza de worktrees.
  - `/recall.md` — busca en memoria.
- `packages/claude-extras/src/subagents/`:
  - `implementer.md` — system prompt de un worker que implementa código.
  - `reviewer.md` — system prompt de un reviewer estricto.
  - `tester.md` — system prompt de un worker que escribe y corre tests.
- `packages/claude-extras/src/hooks/`:
  - `PostToolUse-validate-worktree.sh` — verifica que el modelo no edite fuera del worktree asignado.
  - `PreToolUse-warn-destructive.sh` — pide aprobación extra en ops destructivas.
- `packages/claude-extras/bin/chamba-install` — entry point.

**Acceptance criteria:**
```bash
# En máquina con Claude Code instalado:
npx @chamba/claude-extras install
# Output: "Installed 4 slash commands, 3 subagents, 2 hooks. Added chamba MCP server to ~/.claude.json"

# Verificar:
ls ~/.claude/commands/orq.md     # debe existir
ls ~/.claude/agents/implementer.md
cat ~/.claude.json | grep chamba  # debe estar el server registrado

# En Claude Code:
# /orq agrega health check endpoint
# → debe disparar el flow completo usando las tools de chamba
```

**DoD:**
- Install funciona idempotente (correr 2 veces no rompe nada, avisa qué ya existe).
- Uninstall disponible: `npx @chamba/claude-extras uninstall`.
- Los slash commands referencian las tools MCP correctamente.
- Commit: `feat(claude-extras): slash commands, subagents, hooks installer for Claude Code`.

**📢 Post de LinkedIn:** *"Si usas Claude Code: `npx @chamba/claude-extras install` y obtienes /orq, /workspace, /worktrees + 3 subagentes (implementer, reviewer, tester) listos. Si usas Cursor o VSCode, ya los tenías vía MCP. Todos contentos."* Tema: cómo diseñar herramientas que respeten el editor del usuario.

---

### Fase 8 — Documentación multi-editor + ejemplos 📢

**Estado:** ⏳ Pendiente

**Goal:** README robusto + ejemplos funcionales para los 5 editores principales. Esta es la fase que más impacto va a tener en tracción.

**Entregables:**

- `README.md` raíz completo en inglés con:
  - Hero con tagline en una línea.
  - GIF de la tool funcionando en Cursor.
  - "Why chamba?" con 4-5 bullets.
  - **Sección "Use chamba from your editor"** con configuración exacta por editor (la sección más importante del README).
  - Lista de tools con ejemplos de invocación.
  - "How it works" con diagrama del flujo (modelo del editor invoca tools de chamba).
  - Comparison con Claude Code subagents nativos, lapzo-tools, otros MCP servers.
  - Roadmap.
  - Badges (npm, downloads, CI, license).

- `README.es.md` — versión en español natural latino.

- `examples/cursor-setup/`:
  - `.cursor/mcp.json` listo para pegar.
  - `README.md` con walkthrough paso a paso.
  - Screenshots o GIF.
  - Comandos de ejemplo: `@chamba load context for "add auth"`.

- `examples/claude-code-setup/`:
  - Snippet para `~/.claude.json`.
  - Mención del paquete opcional `@chamba/claude-extras`.
  - Walkthrough de `/orq`.

- `examples/vscode-setup/`:
  - `.vscode/mcp.json` (campo `"servers"`, no `"mcpServers"` — explicar la diferencia).
  - Walkthrough con Copilot Chat en Agent mode.

- `examples/windsurf-setup/`, `examples/opencode-setup/`:
  - Configs y walkthroughs específicos.

- `examples/obsidian-orchestrator/`:
  - Demo end-to-end: vault de prueba, configuración chamba + obsidian-mcp juntos, comando de ejemplo que carga contexto del vault y deja resumen.

**Acceptance criteria:**
```bash
# Validación humana en máquinas distintas:
# - En una Mac con Cursor: seguir cursor-setup/README.md exacto → debe funcionar
# - En una máquina con Claude Code: seguir claude-code-setup → debe funcionar
# - Probar al menos uno más (VSCode o Windsurf)
```

**DoD:**
- Cada ejemplo tiene su propio README ejecutable paso a paso.
- README raíz pasa el "5-second test": un visitante entiende qué es chamba en 5 segundos.
- Al menos un GIF en el README mostrando uso real.
- Commit: `docs: multi-editor setup guides + comprehensive README`.

**📢 Post de LinkedIn:** *"chamba ya tiene guías de setup para Cursor, Claude Code, VSCode, Windsurf y OpenCode. Mismo MCP server, 5 editores, cero API keys. Link en comentarios."* Tema: por qué una herramienta multi-editor desde el día uno es estratégicamente superior.

---

### Fase 9 — Release 1.0.0 + push de tracción 📢📢📢

**Estado:** ⏳ Pendiente

**Goal:** publicar en npm, lanzar campaña de visibilidad.

**Entregables:**
- Release `0.1.0` o `1.0.0-rc.1` en npm para los 4 paquetes (`@chamba/core`, `@chamba/adapters`, `@chamba/mcp`, `@chamba/claude-extras`).
- `CHANGELOG.md` generado.
- Posts preparados para:
  - LinkedIn (español, audiencia LATAM dev) — post largo del journey.
  - X/Twitter (inglés) — hilo con GIF.
  - Hacker News — "Show HN: chamba — MCP server adding orchestrator-worker patterns to any AI editor".
  - Reddit r/LocalLLaMA, r/programming, r/ObsidianMD, r/cursor.
  - dev.to — artículo técnico de profundidad.

**Acceptance criteria:**
```bash
npm view @chamba/mcp                  # info real del paquete
npm view @chamba/claude-extras
npx @chamba/mcp                       # arranca el server desde npm sin clonar
```

**DoD:**
- Los 4 paquetes públicos y instalables.
- En máquina limpia (VM o container): `npm i -g @chamba/mcp`, configurar en Cursor, funciona.
- Star count inicial registrado (baseline).
- Commit: `chore: release 0.1.0`.

**📢 Posts simultáneos en todos los canales.**

---

## 6. Fuera de scope de V1

- **Búsqueda semántica vectorial.** V1 usa búsqueda por keyword. Embeddings va en V2.
- **MCP sampling para usar el modelo del cliente desde chamba.** Lo investigamos en V2 — hoy pocos clientes lo soportan.
- **Modo standalone con LLM propio.** Toda la conversación inicial sobre "harness propio" queda fuera deliberadamente — esto es V2 si la tracción lo justifica.
- **Agent Teams con mailbox peer-to-peer.** Subagents en V1 son configurados via `@chamba/claude-extras`. Mailbox horizontal va en V2.
- **Integración con Logseq, Notion, Roam.** V1 enfocado en Obsidian + filesystem. Otras vienen después.
- **Tracing con OpenTelemetry.** Logs estructurados con pino suficientes en V1.
- **Auto-update del workspace.md por file watchers.** V1 requiere `chamba_workspace_reload` manual invocado por el modelo.
- **Web UI o dashboard.** Si alguien lo quiere, lo construye encima del MCP server.

---

## 7. Checklist de validación final (post-V1)

- [ ] **E1.** Añadir una tool nueva siguiendo el patrón de las existentes. Aparece en `npx @chamba/mcp` automáticamente.
- [ ] **E2.** Customizar el reviewer añadiendo una nueva regla heurística (ej: "warning si toca más de 10 archivos").
- [ ] **E3.** Configurar chamba en un editor MCP-compatible que no esté en la lista de ejemplos (sugerido: Cline) y verificar que funciona.
- [ ] **E4.** Crear un slash command custom para Claude Code que combine 3+ tools de chamba en un flujo (ej: `/quickship` que hace load_context → generate_plan → review_plan → create_worktree).
- [ ] **E5.** Correr el flow completo en un repo git de prueba: workspace_init → load_context → generate_plan → review_plan → create_worktree (paralelo x3) → cleanup_worktree → summarize_to_vault. Verificar que las 3 ramas quedan abiertas, el resumen en el vault es correcto, y no hubo errores.

Si los 5 pasan: chamba está realmente vivo, extensible y consciente del contexto. Y construiste material para 5 posts adicionales en LinkedIn.

---

**Fin del plan.** Cualquier ambigüedad, pregunta antes de improvisar.
