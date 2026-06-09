# PLAN — Construcción de **chamba**

> **Cómo usar este documento**
> Este es el plan maestro para construir `chamba`, un AI agent harness en TypeScript open-source. Está escrito para que **Claude Code lo ejecute por fases**, con verification gates entre cada una. Todo lo que esté en bloques `> Claude Code:` son instrucciones directas para la sesión de Claude Code.
>
> **Flujo de uso recomendado:**
> 1. Crea un repo público vacío en GitHub llamado `chamba`.
> 2. Commitea este `PLAN.md` y el `CLAUDE.md` del Anexo A.
> 3. Abre Claude Code en el repo. Dile: *"Lee PLAN.md y ejecuta la Fase 1 completa. No pases a la Fase 2 hasta que yo apruebe."*
> 4. Al final de cada fase, revisa el commit, corre los acceptance criteria manualmente, aprueba o pide ajustes.
> 5. **Claude Code debe actualizar el estado de cada fase** en este mismo `PLAN.md` cuando la termine: cambiar el campo `**Estado:**` de `⏳ Pendiente` a `✅ Completada — {fecha} — commit {sha-corto}`, **y** actualizar la fila correspondiente en la tabla de "Estado de las fases". Las dos ubicaciones deben estar siempre sincronizadas.
> 6. Al final de las fases marcadas con 📢, publica el post de LinkedIn sugerido para construir tracción.

---

## Estado de las fases

> **Claude Code:** mantén esta tabla actualizada. Cuando empieces una fase, marca `🚧 En progreso`. Cuando termines y commitees, marca `✅ Completada` con fecha y commit SHA corto. Si quedas bloqueado, marca `❌ Bloqueada` y describe brevemente por qué en la celda de fecha. Esta tabla y el campo `**Estado:**` de cada fase son la fuente única de verdad sobre el progreso del proyecto.

| # | Fase | Estado | Fecha | Commit |
|---|---|---|---|---|
| 1 | Bootstrap + ejemplo mínimo | ✅ Completada | 2026-06-09 | d6e4e7f |
| 2 | Núcleo de @chamba/core | ⏳ Pendiente | — | — |
| 3 | Providers reales + tools nativas | ⏳ Pendiente | — | — |
| 4 | Compaction + permisos + memoria | ⏳ Pendiente | — | — |
| 5 | MCP support | ⏳ Pendiente | — | — |
| 5.5 | Workspace + Obsidian | ⏳ Pendiente | — | — |
| 6 | Subagents + orchestrator + reviewer | ⏳ Pendiente | — | — |
| 7 | CLI con Ink | ⏳ Pendiente | — | — |
| 8 | Server HTTP/SSE | ⏳ Pendiente | — | — |
| 8.5 | chamba como MCP server (Cursor/VSCode/etc) | ⏳ Pendiente | — | — |
| 9 | Release 1.0.0 + tracción | ⏳ Pendiente | — | — |

**Símbolos:** ⏳ Pendiente — 🚧 En progreso — ✅ Completada — ❌ Bloqueada

---

## 1. Contexto y objetivo

**chamba** es un AI agent harness en TypeScript, agnóstico de modelo, con soporte de subagentes y patrón orchestrator-worker. Open-source, MIT, publicado en npm.

**De dónde viene el nombre.** "Chamba" es la palabra coloquial latina para *trabajo*. El harness le da chamba al modelo: le pasa la pega, supervisa, valida, y se encarga de toda la coordinación. Personalidad LATAM intencional como punto diferenciador frente a los harnesses gringos.

**Inspirado por** byo-coding-agent (BettaTech), Claude Code, OpenCode y Aider. No reemplaza a ninguno; es la versión productiva, agnóstica, con MCP de primera clase, **workspace-aware** y con orchestrator-worker incluido.

**Para qué lo construyo:**
- Base reutilizable entre mis side projects (VoxCash, fixbody.app, experimentos futuros).
- Material para mi contenido en LinkedIn — cada fase es un post natural en "Deploy on Friday 🔥" y #MenteDeDesarrollador.
- Vehículo para encontrar tracción en GitHub y construir reputación técnica más allá del trabajo de día.
- Aprender harness engineering en serio, no como consumidor de Claude Code, sino entendiendo cómo se construye.

**Done de V1 significa:**
- Un usuario puede correr `npx chamba` en su terminal y conversar con un agente que ejecuta tools en su filesystem.
- Un desarrollador puede `npm install @chamba/core` y embeber el harness en su propia app.
- Un desarrollador puede correr `chamba serve` y exponer el harness vía HTTP/SSE.
- El sistema soporta cambiar de Anthropic a OpenAI con un solo cambio de config.
- El orchestrator puede delegar subtareas a executors especializados (orchestrator-worker pattern).
- Tools y MCP servers se conectan declarativamente, sin tocar el core.
- **chamba entiende el contexto de un workspace** (estructura del proyecto + vault de Obsidian si existe) y lo usa para informar planes y ejecuciones.
- **Existe un comando `/orchestrator <tarea>`** que dispara el flujo completo: cargar contexto → generar plan → auto-evaluar plan → ejecutar en paralelo → testear → resumir y documentar en el vault.
- **chamba se puede invocar desde el chat de cualquier editor con MCP client** (Cursor, VS Code con Copilot, Windsurf, Cline, JetBrains, Trae) corriendo `chamba mcp` como server. Los comandos clave (orchestrate, workspace init, summarize) quedan disponibles como tools directamente en el chat del editor.
- **El orchestrator aísla cada worker en su propio git worktree** cuando el proyecto es un repo git. Workers en paralelo no se pisan archivos, cada uno trabaja en su propia rama. Al terminar, las ramas quedan abiertas para que el humano las revise y mergee manualmente. Si el proyecto no es un repo git, esta capacidad se desactiva automáticamente y el orchestrator delega secuencialmente.
- README listo para Hacker News / Reddit / LinkedIn.

---

## 2. Principios de diseño no-negociables

Los 10 principios que **Claude Code no debe romper** durante la implementación. Si Claude Code encuentra una tensión genuina con alguno, **debe detenerse y preguntar** antes de violarlo.

1. **Ortogonalidad de las 3 capas.** Providers, Tools y Compaction son extension points independientes. Una tool nunca puede asumir un provider específico. Una estrategia de compaction nunca puede asumir una tool específica.

2. **Provider-agnóstico desde el primer commit.** No hay código de Anthropic ni de OpenAI fuera del adapter correspondiente. Si tenemos que decidir entre "lo más rápido para Anthropic" y "lo más portable", siempre gana lo portable.

3. **MCP es ciudadano de primera clase.** Las tools nativas (bash, fs, etc.) y las tools MCP comparten el mismo `Tool` interface. Ninguna parte del core debe distinguir entre "tools nativas" y "tools MCP".

4. **Una sola dependencia externa por capa.** Si un problema ya está resuelto por una librería establecida, la usamos. Pero **no apilamos** librerías que hacen lo mismo. Stack definitivo en sección 4.

5. **Tests obligatorios antes de cerrar una fase.** Si una fase no tiene tests verdes, no se commitea como completa. El `MockProvider` se crea en la Fase 2 precisamente para que las fases siguientes tengan algo barato contra qué testear.

6. **Cada fase termina con algo demoable.** Nada de "fases de refactorización interna". Cada fase produce un comando ejecutable o una capacidad observable nueva — algo que se pueda mostrar en LinkedIn.

7. **El core (`@chamba/core`) no importa Node-specific APIs** como `fs` o `child_process` directamente. Cualquier capacidad que toque el sistema operativo va detrás de un port/adapter. Esto permite testabilidad y, en el futuro, browser/edge compat.

8. **Sin frameworks pesados.** Nada de NestJS, nada de LangChain, nada de Mastra. La librería debe ser puro TypeScript con dependencias mínimas. Hono o Fastify para el server, no NestJS.

9. **Type-first.** Todos los contratos públicos tienen tipos explícitos. No se usa `any` excepto en adapters de SDKs externos donde es estrictamente necesario, con `// eslint-disable-next-line` y justificación.

10. **Errores explícitos.** Las funciones que pueden fallar devuelven `Result<T, E>` (vía `neverthrow`) o lanzan errores tipados. No hay `try/catch` que tragan errores silenciosamente.

---

## 3. Arquitectura objetivo

### Estructura del monorepo

```
chamba/
├── PLAN.md                          # Este documento
├── CLAUDE.md                        # Contexto persistente para Claude Code
├── README.md                        # README público, marketing-grade
├── README.es.md                     # Versión en español
├── CONTRIBUTING.md
├── LICENSE                          # MIT
├── CHANGELOG.md                     # Generado por changesets
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── biome.json
├── vitest.config.ts
├── .changeset/
├── .github/
│   ├── workflows/
│   │   ├── ci.yml
│   │   ├── release.yml
│   │   └── docs.yml
│   ├── ISSUE_TEMPLATE/
│   └── PULL_REQUEST_TEMPLATE.md
│
├── packages/
│   ├── core/                        # @chamba/core
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── harness.ts
│   │   │   ├── repl.ts
│   │   │   ├── agent-loop.ts
│   │   │   ├── api/
│   │   │   │   ├── message.ts
│   │   │   │   ├── block.ts
│   │   │   │   ├── tool-def.ts
│   │   │   │   └── response.ts
│   │   │   ├── provider/
│   │   │   │   ├── provider.ts
│   │   │   │   ├── anthropic.ts
│   │   │   │   ├── openai.ts
│   │   │   │   └── mock.ts
│   │   │   ├── tool/
│   │   │   │   ├── tool.ts
│   │   │   │   ├── registry.ts
│   │   │   │   ├── bash.ts
│   │   │   │   ├── read-file.ts
│   │   │   │   ├── write-file.ts
│   │   │   │   └── mcp-adapter.ts
│   │   │   ├── compact/
│   │   │   │   ├── strategy.ts
│   │   │   │   ├── safe-split.ts    # CRÍTICO
│   │   │   │   ├── none.ts
│   │   │   │   ├── sliding-window.ts
│   │   │   │   └── summarize.ts
│   │   │   ├── permission/
│   │   │   │   ├── policy.ts
│   │   │   │   ├── always-ask.ts
│   │   │   │   ├── always-allow.ts
│   │   │   │   └── allowlist.ts
│   │   │   ├── memory/
│   │   │   │   ├── store.ts
│   │   │   │   └── filesystem-store.ts
│   │   │   ├── workspace/                    # NUEVO (Fase 5.5)
│   │   │   │   ├── workspace.ts              # Tipos y loader
│   │   │   │   ├── scanner.ts                # Escanea dir y genera draft
│   │   │   │   ├── obsidian-detector.ts      # Detecta vault Obsidian
│   │   │   │   └── context-builder.ts        # Compone contexto para el agente
│   │   │   ├── subagent/
│   │   │   │   ├── subagent.ts
│   │   │   │   ├── orchestrator.ts
│   │   │   │   ├── reviewer.ts               # NUEVO (Fase 6)
│   │   │   │   └── delegate-tool.ts
│   │   │   ├── worktree/                     # NUEVO (Fase 6) — aislamiento por worker
│   │   │   │   ├── manager.ts                # WorktreeManager: crea, limpia, lista
│   │   │   │   ├── git-detector.ts           # Detecta si root es repo git
│   │   │   │   └── branch-naming.ts          # Política de nombres de rama
│   │   │   ├── mcp/
│   │   │   │   ├── client.ts
│   │   │   │   └── server-config.ts
│   │   │   ├── ports/
│   │   │   │   ├── filesystem.ts
│   │   │   │   ├── process.ts
│   │   │   │   └── clock.ts
│   │   │   └── events/
│   │   │       └── emitter.ts
│   │   ├── test/
│   │   └── package.json
│   │
│   ├── adapters/                    # @chamba/adapters
│   │   ├── src/
│   │   │   ├── node-filesystem.ts
│   │   │   ├── node-process.ts
│   │   │   └── system-clock.ts
│   │   └── package.json
│   │
│   ├── cli/                         # @chamba/cli — binario `chamba`
│   │   ├── src/
│   │   │   ├── main.ts
│   │   │   ├── ui/
│   │   │   │   ├── app.tsx
│   │   │   │   ├── input.tsx
│   │   │   │   ├── transcript.tsx
│   │   │   │   ├── debug-panel.tsx
│   │   │   │   ├── plan-review.tsx           # NUEVO (Fase 7)
│   │   │   │   └── approval-prompt.tsx
│   │   │   ├── commands/
│   │   │   │   ├── registry.ts
│   │   │   │   ├── help.ts
│   │   │   │   ├── provider.ts
│   │   │   │   ├── model.ts
│   │   │   │   ├── tokens.ts
│   │   │   │   ├── debug.ts
│   │   │   │   ├── compact.ts
│   │   │   │   ├── clear.ts
│   │   │   │   ├── tools.ts
│   │   │   │   ├── subagents.ts
│   │   │   │   ├── workspace.ts              # NUEVO — /workspace init|show|reload
│   │   │   │   ├── orchestrator.ts           # NUEVO — /orq <tarea>
│   │   │   │   └── worktrees.ts              # NUEVO — /worktrees (lista activos)
│   │   │   └── config.ts
│   │   ├── bin/
│   │   │   └── chamba
│   │   └── package.json
│   │
│   └── server/                      # @chamba/server
│       ├── src/
│       │   ├── main.ts
│       │   ├── routes/
│       │   │   ├── sessions.ts
│       │   │   ├── messages.ts
│       │   │   ├── orchestrator.ts           # NUEVO — POST /orchestrator
│       │   │   └── tools.ts
│       │   ├── auth.ts
│       │   └── session-manager.ts
│       ├── Dockerfile
│       └── package.json
│
│   └── mcp/                         # @chamba/mcp — expone chamba como MCP server (NUEVO Fase 8.5)
│       ├── src/
│       │   ├── main.ts              # Entry point; arranca stdio MCP server
│       │   ├── server.ts            # Configura el MCP server con @modelcontextprotocol/sdk
│       │   ├── tools/
│       │   │   ├── orchestrate.ts   # Tool: chamba_orchestrate(task)
│       │   │   ├── workspace.ts     # Tools: chamba_workspace_init|show|reload
│       │   │   ├── summarize.ts     # Tool: chamba_summarize_to_vault
│       │   │   └── plan.ts          # Tool: chamba_generate_plan (sin ejecutar)
│       │   └── config.ts
│       ├── bin/
│       │   └── chamba-mcp           # Binario que se invoca como command desde editores
│       └── package.json
│
└── examples/
    ├── minimal/                     # ~200 líneas, sin abstracciones
    ├── library-usage/               # Embed @chamba/core en una app
    ├── mcp-sqlite/                  # Demo MCP local con SQLite
    ├── obsidian-orchestrator/       # NUEVO — workspace + Obsidian + orchestrator
    ├── editor-integration/          # NUEVO (Fase 8.5) — configs de Cursor/VSCode/etc
    └── orchestrator-team/           # Demo orchestrator-worker puro
```

### El directorio `.chamba/` del usuario (no del repo)

Cuando un usuario corre `chamba` en una carpeta, esta es la estructura que el harness crea/usa:

```
mi-proyecto/                        # Carpeta del usuario (cualquier proyecto)
├── ...código del proyecto...
└── .chamba/                        # Generado por chamba
    ├── workspace.md                # Mapa del workspace (generado por /workspace init, editable a mano)
    ├── config.json                 # MCP servers, providers, permission policy
    ├── agents/                     # System prompts de los sub-agentes
    │   ├── orchestrator.md
    │   ├── reviewer.md
    │   ├── implementer.md
    │   └── tester.md
    ├── plans/                      # Planes generados por el orchestrator
    │   └── 2026-06-09-auth-magic-links.md
    ├── worktrees/                  # NUEVO (Fase 6) — worktrees activos del orchestrator
    │   └── 2026-06-09-auth-magic-links/
    │       ├── backend-worker/     # git worktree con rama chamba/2026-06-09-auth-magic-links/backend-worker
    │       └── frontend-worker/    # git worktree con rama chamba/2026-06-09-auth-magic-links/frontend-worker
    └── memory/                     # Memoria persistente entre sesiones
        └── {sessionId}/
            └── *.md
```

**Importante:** este directorio es para el usuario de chamba, no para el repo de chamba. El repo de chamba **no** tiene `.chamba/` (excepto en `examples/` para demos).

### Interfaces clave (pseudocódigo TypeScript)

> **Claude Code:** estas son las firmas exactas. Implementa siguiendo estas signatures. Si ajustas, documenta el por qué en el commit.

```typescript
// @chamba/core/api/message.ts
export type Role = 'user' | 'assistant' | 'system';

export interface Message {
  role: Role;
  content: Block[];
}

export type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean };

// @chamba/core/api/tool-def.ts
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JSONSchema7;
}

// @chamba/core/api/response.ts
export interface Response {
  blocks: Block[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence';
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number };
}

// @chamba/core/provider/provider.ts
export interface Provider {
  readonly name: string;
  getModel(): string;
  setModel(name: string): void;
  send(args: {
    systemPrompt: string;
    messages: Message[];
    tools: ToolDef[];
    signal?: AbortSignal;
  }): Promise<Response>;
}

// @chamba/core/tool/tool.ts
export interface Tool {
  definition(): ToolDef;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolContext {
  cwd: string;
  filesystem: FilesystemPort;
  process: ProcessPort;
  signal: AbortSignal;
}

export type ToolResult =
  | { ok: true; content: string }
  | { ok: false; error: string };

// @chamba/core/compact/strategy.ts
export interface CompactionStrategy {
  readonly name: string;
  compact(messages: Message[], provider: Provider): Promise<Message[]>;
}

// @chamba/core/permission/policy.ts
export interface PermissionPolicy {
  shouldAllow(toolName: string, input: unknown): Promise<Decision>;
}

export type Decision =
  | { allow: true }
  | { allow: false; reason: string }
  | { allow: 'ask'; };

// @chamba/core/workspace/workspace.ts  (NUEVO Fase 5.5)
export interface Workspace {
  root: string;
  hasObsidianVault: boolean;
  vaultPath?: string;
  description: string;             // Resumen de alto nivel
  conventions: string[];           // Convenciones explícitas
  activeProjects: ProjectRef[];
  toMarkdown(): string;            // Serializa a workspace.md
}

export interface WorkspaceScanner {
  scan(root: string): Promise<Workspace>;
  detectVault(root: string): Promise<string | null>;
}

export interface ContextBuilder {
  build(workspace: Workspace, task: string): Promise<string>;
  // Devuelve el bloque de contexto a inyectar en el system prompt del orchestrator
}

// @chamba/core/subagent/reviewer.ts  (NUEVO Fase 6)
export interface PlanReview {
  approved: boolean;
  gaps: string[];
  suggestions: string[];
  riskFlags: string[];
}

export interface Reviewer {
  review(plan: string, context: string, task: string): Promise<PlanReview>;
}

// @chamba/core/worktree/manager.ts  (NUEVO Fase 6)
export interface WorktreeHandle {
  branch: string;             // e.g. "chamba/2026-06-09-add-health-check/backend-worker"
  path: string;               // path absoluto al worktree creado
  baseBranch: string;         // rama desde la que se ramificó
  workerId: string;
  taskSlug: string;
  createdAt: string;          // ISO timestamp
}

export interface WorktreeManager {
  isGitRepo(root: string): Promise<boolean>;
  create(opts: {
    root: string;
    workerId: string;
    taskSlug: string;
    baseBranch?: string;      // por defecto la rama actual
  }): Promise<WorktreeHandle>;
  list(root: string): Promise<WorktreeHandle[]>;
  /**
   * Cleanup NO borra branches ni hace merge.
   * Solo remueve el directorio de worktree, dejando la rama intacta para review humano.
   * El humano hace merge a mano cuando esté listo.
   */
  cleanup(handle: WorktreeHandle): Promise<void>;
}

// @chamba/core/harness.ts
export class Harness {
  constructor(opts: {
    provider: Provider;
    tools: Tool[];
    compaction: CompactionStrategy;
    permission: PermissionPolicy;
    memory?: MemoryStore;
    workspace?: Workspace;          // NUEVO Fase 5.5
    systemPrompt: string;
    onEvent?: (event: HarnessEvent) => void;
  });

  async send(userInput: string): Promise<AsyncIterable<HarnessEvent>>;
  async runOrchestrator(task: string): Promise<OrchestratorResult>;  // NUEVO Fase 6
  async addSubagent(config: SubagentConfig): Promise<void>;
  reset(): void;
  getUsage(): UsageStats;
}

export interface OrchestratorResult {
  plan: string;
  reviews: PlanReview[];
  executions: SubagentExecution[];
  testResults: TestResult[];
  summary: string;
  vaultNotePath?: string;          // Si se escribió resumen a Obsidian
  pendingBranches?: string[];      // Ramas creadas en worktrees que quedan abiertas para review humano
}
```

---

## 4. Stack y dependencias justificadas

Cada dependencia tiene una razón para estar y una razón por la que no se eligió la alternativa obvia.

| Capa | Dependencia | Versión | Por qué | Por qué NO la alternativa |
|---|---|---|---|---|
| Build tool | `tsup` | ^8 | Bundle por paquete, dual ESM/CJS, sin config | `tsc` solo no genera CJS limpio; `vite` es overkill |
| Lint + format | `biome` | ^2 | Una sola dep, 10x más rápido que ESLint+Prettier | ESLint+Prettier = 2 deps, 2 configs, 2 procesos |
| Tests | `vitest` | ^2 | Compatible con TS sin transpiler aparte, watch rápido | `jest` requiere `ts-jest` o `babel-jest`, lento |
| Validación | `zod` | ^3 | Schemas que también generan tipos TS | `yup` no infiere tipos tan bien; `valibot` es más nuevo |
| Result types | `neverthrow` | ^8 | `Result<T,E>` ergonómico | `fp-ts` es enorme |
| HTTP server | `hono` | ^4 | Mínimo, type-safe, SSE nativo | `express` no tiene types nativos; `fastify` es más pesado |
| TUI | `ink` | ^5 | React para terminal, componente-based | `blessed` está abandonado |
| MCP client | `@modelcontextprotocol/sdk` | latest | SDK oficial | No hay alternativa madura |
| Anthropic SDK | `@anthropic-ai/sdk` | latest | SDK oficial | — |
| OpenAI SDK | `openai` | latest | SDK oficial | — |
| Logging | `pino` | ^9 | Estructurado, rápido | `winston` es más lento y verboso |
| Workspace | `pnpm` | ^9 | Workspaces nativos eficientes | `npm workspaces` más lento |
| Versionado | `changesets` | ^2 | Estándar para monorepos publicables en npm | `lerna` está en mantenimiento |

**MCP servers de terceros que vamos a recomendar (no son dependencias, son configuración del usuario):**
- `obsidian-mcp` — para vaults de Obsidian. Se instala vía `npx`.
- MCP servers oficiales del registry de Anthropic (filesystem, github, postgres, etc.) según necesidad del usuario.

**Lo que NO usamos y por qué:**

- **LangChain / LangGraph** — exactamente lo que estamos construyendo nosotros. Sería absurdo.
- **Vercel AI SDK** — considerado seriamente. Nos da provider abstraction gratis. Pero (a) nos ataría a su forma de hacer tool calling, (b) nuestro objetivo es entender la abstracción, no consumirla. Si en el futuro queremos sacrificar control por velocidad, refactorizar `provider/` para usarlo por debajo es ~1 día.
- **NestJS** — sobreingeniería absoluta. Hono cubre lo necesario.
- **Mastra, Inngest agent kit, OpenAI Agents SDK** — frameworks. Pelean con el modelo mental de harness.

---

## 5. Plan de ejecución por fases

Cada fase tiene:
- **Goal** — qué se logra al final.
- **Entregables** — archivos concretos a crear/modificar.
- **Acceptance criteria** — comandos exactos que tienen que pasar.
- **Definition of Done** — el commit final no se hace hasta cumplir todo.
- 📢 marca dónde generar contenido para LinkedIn.

> **Claude Code:** ejecuta una fase a la vez. Al terminar, espera aprobación humana antes de avanzar. Si un AC falla, no inventes workarounds; reporta el problema y espera instrucciones.

---

### Fase 1 — Bootstrap del monorepo + ejemplo mínimo 📢

**Estado:** ✅ Completada — 2026-06-09 — d6e4e7f

**Goal:** que `pnpm install && pnpm --filter @chamba/examples-minimal start` levante un REPL conversando con Claude en ~200 líneas en un solo archivo, sin abstracciones. La esencia del harness antes de meter capas.

**Entregables:**
- `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `biome.json`, `vitest.config.ts`.
- `.gitignore`, `.nvmrc` (Node 22 LTS), `.editorconfig`.
- `LICENSE` (MIT), `CONTRIBUTING.md`.
- `packages/core/package.json` con dependencias declaradas, solo `index.ts` con `export {};`.
- `examples/minimal/main.ts` — implementación monolítica directa con `@anthropic-ai/sdk`:
  - REPL loop con `readline`.
  - Agent loop interno que maneja `tool_use` blocks.
  - 3 tools hardcoded: `bash`, `read_file`, `write_file`.
  - Approval prompt antes de cada tool execution.
  - Sin abstracciones, sin interfaces. Código intencionalmente "feo y directo".
- `examples/minimal/package.json` con script `start`.
- `README.md` raíz versión inicial (se pule después).

**Acceptance criteria:**
```bash
pnpm install                                              # No errors
pnpm biome check .                                        # No errors
pnpm --filter @chamba/examples-minimal exec tsc --noEmit  # No errors
ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @chamba/examples-minimal start
# Debe abrir el REPL. Probar:
#   > list the files here
# El agente pide aprobación para bash, ejecuta, responde.
```

**DoD:**
- `examples/minimal/main.ts` tiene **menos de 250 líneas**.
- Commit: `feat: bootstrap monorepo + minimal agent loop example`.

**📢 Post de LinkedIn al cerrar la fase:** *"Hice un agente en 200 líneas — y lo más interesante no es que funcione, es lo que **no** tiene. Spoiler: lo voy a romper en pedazos en los próximos posts."* Serie: Deploy on Friday 🔥.

---

### Fase 2 — Núcleo de `@chamba/core`: API types, Provider interface, MockProvider, agent loop

**Estado:** ⏳ Pendiente

**Goal:** primera versión abstraída con Provider polymorphism y MockProvider para que todo sea testeable sin API real.

**Entregables:**
- `packages/core/src/api/` completo (Message, Block, ToolDef, Response).
- `packages/core/src/provider/provider.ts` (interface).
- `packages/core/src/provider/mock.ts` — MockProvider con `enqueueResponse(response)` y `getCalls()`.
- `packages/core/src/agent-loop.ts` — bucle interno desacoplado. Recibe `Provider`, `Tool[]`, `messages`, devuelve `messages` actualizados.
- `packages/core/src/tool/tool.ts` + `tool/registry.ts`.
- Tests en `packages/core/test/agent-loop.test.ts`:
  - Loop termina con `stopReason: 'end_turn'`.
  - Loop ejecuta tools y reinvoca al provider.
  - Loop maneja errores de tool sin crashear.
  - Loop respeta `AbortSignal`.

**Acceptance criteria:**
```bash
pnpm --filter @chamba/core test                # All green
pnpm --filter @chamba/core build               # Genera dist/
pnpm --filter @chamba/core exec tsc --noEmit   # No errors
```

**DoD:**
- Coverage del agent loop > 85%.
- `MockProvider` se usa en todos los tests. Cero tests llaman a Anthropic real.
- **Actualizar el README raíz** añadiendo un primer borrador del paso 9 ("Use as a library") de la sección "Step-by-step usage guide": un snippet TypeScript mínimo (10-15 líneas) que importe `MockProvider` y muestre cómo instanciar un agent loop básico. Este snippet se completa en Fase 3 con providers reales.
- Commit: `feat(core): agent loop with provider abstraction and mock provider`.

---

### Fase 3 — AnthropicProvider + OpenAIProvider + tools nativas 📢

**Estado:** ⏳ Pendiente

**Goal:** dos providers reales implementados contra el mismo interface, y las 3 tools nativas usando ports.

**Entregables:**
- `packages/core/src/ports/` — interfaces `FilesystemPort`, `ProcessPort`, `ClockPort`.
- `packages/adapters/src/` — implementaciones Node de esos ports.
- `packages/core/src/provider/anthropic.ts` — adapter para `@anthropic-ai/sdk`.
- `packages/core/src/provider/openai.ts` — idem para `openai`.
- `packages/core/src/tool/bash.ts`, `read-file.ts`, `write-file.ts` — usan los ports.
- Tests para cada provider con `nock` o `msw`.
- Tests para cada tool con `FilesystemPort` en memoria.

**Acceptance criteria:**
```bash
pnpm --filter @chamba/core test
# Smoke tests (requieren API keys):
ANTHROPIC_API_KEY=... pnpm tsx scripts/smoke-anthropic.ts
OPENAI_API_KEY=... pnpm tsx scripts/smoke-openai.ts
```

**DoD:**
- El mismo test de integración del agent loop pasa con Anthropic y con OpenAI (parametrizado).
- Las tools no importan `fs` ni `child_process` directamente desde `@chamba/core`.
- Commit: `feat(core): anthropic + openai providers + native tools via ports`.

**📢 Post de LinkedIn:** *"Mi agente ya no depende de Claude. Cambio una línea y corre en GPT. Te muestro el patrón en 3 minutos."* Tema: provider abstraction como el lock-in más fácil de evitar.

---

### Fase 4 — Compaction strategies + SafeSplitPoint + Permission policies + Memory

**Estado:** ⏳ Pendiente

**Goal:** las tres capas que convierten el agent loop en algo usable a largo plazo: gestión de contexto, control de seguridad, persistencia.

**Entregables:**
- `packages/core/src/compact/`:
  - `strategy.ts` (interface).
  - `safe-split.ts` — implementación que garantiza no separar un `tool_use` de su `tool_result`. **Crítico, prioriza tests exhaustivos.**
  - `none.ts`, `sliding-window.ts`, `summarize.ts`.
- `packages/core/src/permission/`:
  - `policy.ts` (interface).
  - `always-allow.ts`, `always-ask.ts`, `allowlist.ts`.
  - El agent-loop consulta la policy antes de cada tool execution.
- `packages/core/src/memory/`:
  - `store.ts` (interface).
  - `filesystem-store.ts` — guarda en `~/.chamba/memory/{sessionId}/*.md`.
  - Tools `remember` y `recall`.
- `packages/core/src/harness.ts` — clase pública que compone todo.
- Tests exhaustivos para SafeSplitPoint (mínimo 10 casos edge).

**Acceptance criteria:**
```bash
pnpm --filter @chamba/core test
# Tests específicos de SafeSplitPoint deben cubrir:
# - mensaje normal de texto al final
# - tool_use sin tool_result al final → excluye el tool_use
# - tool_result sin tool_use previo → incluye el tool_use anterior
# - secuencia tool_use → tool_result → tool_use → tool_result al final → respeta pares
# - mensaje single con multiple tool_use blocks → all-or-nothing
```

**DoD:**
- `Harness` class instanciable con composición completa.
- Commit: `feat(core): compaction, permissions, memory + harness class`.

---

### Fase 5 — MCP support 📢

**Estado:** ⏳ Pendiente

**Goal:** tools provistas por MCP servers externos, indistinguibles de las tools nativas desde el core.

**Entregables:**
- `packages/core/src/mcp/client.ts` — wrapper sobre `@modelcontextprotocol/sdk`. Soporta stdio y SSE.
- `packages/core/src/mcp/server-config.ts` — schema Zod para configuración de servers MCP (formato compatible con Claude Code: `{ command, args, env }`).
- `packages/core/src/tool/mcp-adapter.ts` — adapta una tool MCP al `Tool` interface. Coexiste con nativas en el mismo registry sin que el agent-loop se entere.
- Demo: `examples/mcp-sqlite/main.ts` — agente que conecta a un MCP server de SQLite local, crea una DB ejemplo, ejecuta queries. Funciona sin servicios externos para que cualquiera que clone el repo lo pueda probar.
- Tests con MCP server mock (child process que habla el protocolo).

**Acceptance criteria:**
```bash
pnpm --filter @chamba/core test
pnpm --filter @chamba/examples-mcp-sqlite start
# > how many users are in the users table?
# El agente usa la tool MCP y responde con un número real.
```

**DoD:**
- Una tool MCP se registra exactamente con `registry.register(await MCPAdapter.fromConfig(config))`. **Cero código especial en agent-loop.**
- Commit: `feat(core): MCP client + adapter for native interop`.

**📢 Post de LinkedIn:** *"Conecté mi agente a una base de datos en 4 líneas. Sin tools custom, sin adaptadores. Esto es MCP."* Tema: por qué MCP cambia las reglas de los harnesses caseros.

---

### Fase 5.5 — Workspace context + Obsidian integration 📢

**Estado:** ⏳ Pendiente

**Goal:** chamba entiende el contexto del directorio donde se ejecuta. Si hay un vault de Obsidian, lo detecta y lo usa. Si no hay `workspace.md`, lo genera (con tu aprobación). El contexto del workspace se inyecta automáticamente en futuras conversaciones y planes.

**Por qué esta fase importa:** sin contexto del workspace, el orchestrator de la Fase 6 trabajaría a ciegas. Esta fase es lo que diferencia "un harness genérico" de "un harness que entiende dónde vivo y cómo trabajo".

**Entregables:**

- `packages/core/src/workspace/workspace.ts` — tipos `Workspace`, `ProjectRef` y loader que lee `.chamba/workspace.md`.

- `packages/core/src/workspace/scanner.ts` — clase `WorkspaceScanner`:
  - `scan(root)` recorre el directorio (respeta `.gitignore`), identifica archivos clave (`README*`, `package.json`, `pyproject.toml`, `Cargo.toml`, etc.), detecta lenguajes, framework principal, estructura.
  - Genera un `workspace.md` draft con secciones: descripción, convenciones detectadas, proyectos activos, mapa de carpetas.

- `packages/core/src/workspace/obsidian-detector.ts`:
  - Detecta vault de Obsidian buscando el directorio `.obsidian/` en `root` o en `~/Documents/`, `~/Notes/`, y rutas comunes.
  - Permite especificar el path manualmente vía config si la auto-detección falla.
  - Devuelve `{ found: boolean, path?: string, noteCount?: number }`.

- `packages/core/src/workspace/context-builder.ts`:
  - `build(workspace, task)` produce un bloque markdown que se inyecta en el system prompt del orchestrator.
  - Contiene: descripción del workspace + convenciones + lista de proyectos activos + (si hay Obsidian) lista de notas potencialmente relevantes según el task (búsqueda por keywords).

- **Nuevas tools nativas:**
  - `init_workspace` — genera `.chamba/workspace.md` draft escaneando el directorio actual.
  - `read_workspace` — lee el `workspace.md` actual.
  - `update_workspace` — actualiza secciones específicas del workspace.md.
  - `summarize_to_vault` — si hay vault de Obsidian, crea una nota estructurada en `vault/proyectos/{fecha}-{slug}.md` con: tarea original, plan ejecutado, archivos tocados, decisiones tomadas, próximos pasos.

- **MCP server recomendado:** documentar en README cómo configurar `obsidian-mcp` en `.chamba/config.json`:
  ```json
  {
    "mcpServers": {
      "obsidian": {
        "command": "npx",
        "args": ["-y", "obsidian-mcp", "--vault", "$OBSIDIAN_VAULT_PATH"]
      }
    }
  }
  ```

- **Hooks de eventos nuevos:** `workspace.initialized`, `workspace.updated`, `vault.note_created` — para que el CLI/server los muestren al usuario.

- Tests:
  - Scanner detecta correctamente un dir Node (con `package.json`), un dir Python (con `pyproject.toml`), un dir mixto.
  - Obsidian-detector encuentra `.obsidian/` en diferentes ubicaciones; falla limpiamente si no existe.
  - Context-builder produce markdown válido y trimea a un tamaño máximo configurable (por defecto 2000 tokens).
  - Tools `init_workspace` y `summarize_to_vault` con `FilesystemPort` en memoria.

**Acceptance criteria:**
```bash
pnpm --filter @chamba/core test

# Smoke manual:
cd /tmp && mkdir test-workspace && cd test-workspace
echo '{"name":"test","dependencies":{"express":"^4"}}' > package.json
npx tsx /path/to/chamba/scripts/smoke-workspace.ts
# Debe:
# 1. Escanear el dir
# 2. Generar .chamba/workspace.md con secciones correctas
# 3. Detectar que no hay vault Obsidian (ok)
# 4. Producir contexto inyectable

# Con vault Obsidian:
OBSIDIAN_VAULT_PATH=~/Obsidian/MiVault npx tsx scripts/smoke-workspace-obsidian.ts
# Debe detectar el vault, contar notas, y listar las relevantes para el task de prueba
```

**DoD:**
- El scanner respeta `.gitignore` y `.dockerignore`. No lee binarios. No lee `node_modules/`.
- El `workspace.md` generado es legible por humanos y editable a mano. **El usuario debe poder modificarlo y chamba debe respetar las ediciones.**
- Si el usuario edita `workspace.md` manualmente, el scanner no debe sobrescribirlo sin confirmación.
- `summarize_to_vault` falla con mensaje claro si no hay vault configurado.
- Commit: `feat(core): workspace context + obsidian integration`.

**📢 Post de LinkedIn:** *"Mi agente ahora entiende mi vault de Obsidian. Le pido algo y antes de actuar, busca contexto en mis notas. Esto cambia cómo trabajo."* Tema: por qué un agente sin contexto de tu workspace es un asistente genérico, no un asistente personal.

---

### Fase 6 — Subagentes + orchestrator-worker pattern + Reviewer 📢

**Estado:** ⏳ Pendiente

**Goal:** el harness instancia subagentes con su propio provider, tools, system prompt y permission policy. Implementa el flujo completo del orchestrator: **carga contexto → genera plan → reviewer auto-evalúa plan → ejecuta workers en paralelo → tester valida → summarize a vault**.

**Entregables:**

- `packages/core/src/subagent/subagent.ts` — clase `Subagent` = Harness restringido con parent reference. Hereda workspace del parent si no se especifica uno propio. **Recibe un `cwd` específico al instanciarse — si el orchestrator le pasa un worktree, todas las tools del subagent operan ahí.**

- `packages/core/src/subagent/delegate-tool.ts` — tool `delegate_to_subagent` que recibe `{ agent, task, context }`, instancia el subagent, ejecuta, devuelve resumen.

- `packages/core/src/worktree/manager.ts` — `WorktreeManager` que gestiona git worktrees:
  - `isGitRepo(root)` — `git rev-parse --is-inside-work-tree`.
  - `create({ root, workerId, taskSlug, baseBranch })` — crea worktree en `.chamba/worktrees/{taskSlug}/{workerId}/` con rama nueva `chamba/{taskSlug}/{workerId}`. Usa el `ProcessPort` para invocar `git worktree add`.
  - `list(root)` — parsea `git worktree list --porcelain`.
  - `cleanup(handle)` — **solo** ejecuta `git worktree remove` (sin `--force` por defecto). **NUNCA borra la rama ni hace merge.** La rama queda viva para que el humano la revise.

- `packages/core/src/worktree/git-detector.ts` — detecta si el `cwd` es un repo git. Resultado se cachea por sesión.

- `packages/core/src/worktree/branch-naming.ts` — convención de nombres: `chamba/{YYYY-MM-DD}-{task-slug}/{worker-id}`. Sanitiza para que git no se queje (lowercase, sin espacios, sin caracteres reservados).

- `packages/core/src/subagent/reviewer.ts` — `Reviewer` class (sin cambios respecto al plan anterior).

- `packages/core/src/subagent/orchestrator.ts` — `createOrchestrator(opts)` que configura un Harness con:
  - System prompt que prohíbe Edit/Write/Bash directos.
  - Tools restringidas: `read_file`, `grep`, `search_notes` (si hay Obsidian), `delegate_to_subagent`, `summarize_to_vault`.
  - Workspace context inyectado automáticamente.
  - Reviewer integrado en el flow.
  - **WorktreeManager integrado.** Antes de delegar a cada subagent, si el repo es git, el orchestrator crea un worktree y se lo pasa al subagent como su `cwd`. Si no es git, los workers comparten el `cwd` original y el orchestrator los serializa (no corre dos workers en paralelo en el mismo directorio).
  - Subagentes registrados disponibles para delegación.

- **Flujo completo del orchestrator (versión actualizada con worktrees):**
  ```
  1. Recibir task
  2. Cargar contexto (workspace.md + búsqueda en vault si aplica)
  3. Generar plan inicial → .chamba/plans/{fecha}-{slug}.md
  4. Llamar reviewer.review(plan)
  5. Si approved=false: re-planear con feedback, volver a paso 4 (max 3 iteraciones)
  6. Mostrar plan al humano para aprobación final (vía evento; en CLI esto pausa, en server espera POST)
  7. Para cada tarea del plan que va a un worker:
     7a. Si el repo es git: WorktreeManager.create() → worktree dedicado en .chamba/worktrees/
     7b. Si no es git: usar cwd original; encolar serialmente
     7c. Delegar al subagent con su cwd correspondiente
  8. Cada worker termina → tester valida → si falla, replantea esa tarea en el MISMO worktree
  9. Al terminar TODOS los workers:
     - WorktreeManager.cleanup() para cada handle (borra el dir, NO la rama)
     - El orchestrator lista las ramas creadas en el summary para que el humano sepa qué mergear
  10. Llamar summarize_to_vault con resumen completo incluyendo la lista de ramas pendientes de review
  11. Devolver OrchestratorResult al caller
  ```

- `examples/orchestrator-team/main.ts` — demo concreto: orchestrator + reviewer + implementer + tester construyendo un mini módulo en un repo git de demo. **Debe mostrar la creación de los worktrees, ejecución paralela, y al final el listado de ramas pendientes de merge.**

- `examples/obsidian-orchestrator/` — demo end-to-end con vault Obsidian (sin cambios respecto al plan anterior).

- Tests verifican:
  - Un subagent puede ejecutar tools que el orchestrator no puede.
  - El orchestrator recibe el resumen del subagent como `tool_result`.
  - Subagents corren en paralelo cuando el orchestrator delega múltiples tareas **y el repo es git**.
  - Subagents corren serialmente cuando el repo **no es git**.
  - WorktreeManager.create crea el worktree correctamente y devuelve un handle válido.
  - WorktreeManager.cleanup remueve el directorio pero la rama sigue existiendo (`git branch --list chamba/*` la muestra).
  - El reviewer puede rechazar un plan y forzar re-planeo.
  - El orchestrator escala correctamente cuando hay loop infinito de rechazos (corta después de 3 iteraciones).
  - Si `git worktree add` falla (rama ya existe, conflicto, etc.), el orchestrator reporta error claro y no continúa con esa tarea.

**Acceptance criteria:**
```bash
pnpm --filter @chamba/core test

# Demo orchestrator-worker puro:
pnpm --filter @chamba/examples-orchestrator-team start
# El orchestrator descompone una tarea, el reviewer la audita,
# y los workers la ejecutan en paralelo.

# Demo con vault Obsidian:
pnpm --filter @chamba/examples-obsidian-orchestrator start
# El orchestrator carga contexto del vault, genera plan que cita notas,
# y al terminar escribe resumen al vault.
```

**DoD:**
- Subagents corren con su propio context window (no comparten messages con parent).
- Reviewer rechaza al menos un escenario en los tests (caso de plan obviamente incompleto).
- El demo `obsidian-orchestrator` muestra al menos una cita a una nota del vault en el plan generado.
- **WorktreeManager funcional**: si corres el demo orchestrator-team en un repo git, después de terminar debes poder hacer `git branch --list 'chamba/*'` y ver las ramas creadas por los workers, sin merged y sin borradas.
- **Detección git robusta**: si corres el demo en un directorio que NO es git, el orchestrator delega serialmente sin intentar crear worktrees, y lo anuncia en su output ("non-git workspace, workers run sequentially").
- Commit: `feat(core): subagents + orchestrator-worker pattern + reviewer + worktrees + obsidian flow`.

**📢 Post de LinkedIn:** *"Mi agente ahora delega como un tech lead. Genera plan, lo audita, lo ejecuta en paralelo, lo prueba, y deja todo documentado en mi vault de Obsidian. ¿Por qué este patrón cambia todo?"* Tema: orchestrator-worker explicado para developers, con énfasis en el reviewer como gate crítico y en la conexión con el sistema de notas personal. Va en #MenteDeDesarrollador porque conecta directamente con la práctica de tech leadership humano.

---

### Fase 7 — `@chamba/cli`: CLI con Ink + comandos `/workspace` y `/orq` 📢

**Estado:** ⏳ Pendiente

**Goal:** la TUI usable diariamente. Comandos para inicializar workspace y disparar el orchestrator desde una sola línea.

**Entregables:**
- `packages/cli/src/main.ts` — entry point con `commander`.
- `packages/cli/src/ui/app.tsx` — componente raíz Ink: transcript scrolleable, input box, status bar.
- `packages/cli/src/ui/debug-panel.tsx` — panel toggleable con último payload enviado/recibido.
- `packages/cli/src/ui/approval-prompt.tsx` — modal de aprobación con yes/no/always-for-this-tool.
- `packages/cli/src/ui/plan-review.tsx` — UI específico para revisar el plan del orchestrator antes de ejecutar:
  - Muestra el plan en formato markdown renderizado.
  - Muestra el feedback del reviewer.
  - Opciones: approve, edit (abre `$EDITOR`), reject (descarta plan y pide nuevo).

- `packages/cli/src/commands/` — slash commands:
  - `/help`
  - `/provider`, `/model`, `/tokens`, `/debug`, `/compact`, `/clear`, `/tools`, `/subagents`, `/exit`
  - **`/workspace init`** — escanea dir actual, genera `.chamba/workspace.md`, lo abre en `$EDITOR` para aprobación.
  - **`/workspace show`** — muestra el workspace.md actual.
  - **`/workspace reload`** — re-escanea y mergea con el workspace.md existente (no sobrescribe, propone diff).
  - **`/orq <tarea>`** o **`/orchestrator <tarea>`** — dispara el flujo completo de orchestrator. Muestra plan-review UI cuando el plan está listo, después muestra progreso en vivo de los workers en paralelo. **Al final, muestra una sección de "branches pendientes" listando los worktrees creados y los comandos `git merge` sugeridos** para que el humano pueda revisar y mergear con un copy-paste.
  - **`/worktrees`** — nuevo comando que lista los worktrees activos de chamba en el repo actual (parsea `git worktree list`). Útil para limpiar manualmente si quedaron worktrees zombi por crash o Ctrl+C abrupto.

- `packages/cli/src/config.ts` — carga `.chamba/config.json` del CWD + `~/.chamba/config.json` global (CWD overrides global).
- `packages/cli/bin/chamba` — shebang script para `npx chamba` o install global.
- Soporte historial multi-línea (Shift+Enter).
- Spinner mientras el provider piensa.
- Auto-detección de workspace al arrancar: si hay `.chamba/workspace.md`, lo carga; si no, sugiere `/workspace init`.

**Acceptance criteria:**
```bash
pnpm --filter @chamba/cli build
node packages/cli/bin/chamba
# Verificar interactivamente:
# - / muestra autocompletado de slash commands
# - /workspace init genera workspace.md correctamente
# - /workspace show lo renderiza bien
# - /orq "agrega un endpoint health check" dispara el flow completo:
#   muestra plan, plan-review UI, espera aprobación, ejecuta, muestra progreso, summary final
# - /debug on muestra el panel
# - Approval prompt antes de cada tool
# - /provider openai cambia provider sin reiniciar
# - Ctrl+C limpia y sale sin orphan processes
```

**DoD:**
- `pnpm pack` genera tarball instalable globalmente.
- Asciinema o GIF demo grabado para el README, mostrando especialmente el flujo `/orq`.
- El UI de plan-review es navegable con teclado (no requiere mouse).
- **Actualizar el README raíz** añadiendo una versión inicial (no final, eso es Fase 9) de la sección "Step-by-step usage guide" cubriendo los pasos 1-8 y 11-12 del listado de Fase 9. Los pasos 9 (library usage) y 10 (server usage) se completan después en sus respectivas fases. El README de Fase 9 solo pule y agrega lo que falta, no escribe de cero.
- Commit: `feat(cli): TUI with ink + workspace and orchestrator commands`.

**📢 Post de LinkedIn:** *"chamba ya tiene CLI. `npx chamba`, después `/orq agrega auth con magic links` y se encarga del resto. GIF abajo."* Aquí es donde se busca tracción real con un demo concreto.

---

### Fase 8 — `@chamba/server`: HTTP/SSE 📢

**Estado:** ⏳ Pendiente

**Goal:** harness expuesto vía HTTP para integrar desde otras apps. SSE para streaming. Endpoint específico para el orchestrator.

**Entregables:**
- `packages/server/src/main.ts` — server Hono en puerto configurable.
- Endpoints:
  - `POST /sessions` — crea sesión, devuelve `sessionId`.
  - `GET /sessions/:id` — estado (transcript, usage, workspace cargado).
  - `POST /sessions/:id/messages` — envía mensaje, devuelve SSE stream: `text_delta`, `tool_call_request`, `tool_call_result`, `done`.
  - `POST /sessions/:id/approvals` — responde a un tool_call_request pendiente.
  - **`POST /sessions/:id/orchestrator`** — dispara flow del orchestrator. SSE stream con eventos: `plan_generated`, `plan_reviewed`, `plan_approval_required`, `worker_started`, `worker_progress`, `worker_completed`, `test_started`, `test_completed`, `summary_written`, `done`.
  - `POST /sessions/:id/orchestrator/approve-plan` — aprueba o rechaza un plan pendiente.
  - `POST /sessions/:id/workspace/init` — inicializa workspace en el dir del server.
  - `GET /sessions/:id/workspace` — devuelve workspace.md actual.
  - `GET /tools` — lista de tools disponibles.
- `packages/server/src/session-manager.ts` — ciclo de vida en memoria, cleanup tras 30min.
- `packages/server/src/auth.ts` — validación por API key vía header.
- Tests de integración estilo `supertest`.
- OpenAPI spec con `@hono/zod-openapi`.
- `Dockerfile` para deploy fácil.

**Acceptance criteria:**
```bash
pnpm --filter @chamba/server start
# Otra terminal:
curl -X POST http://localhost:3000/sessions -H "X-API-Key: dev"
# → { sessionId: "..." }

# Disparar orchestrator vía HTTP:
curl -N -X POST http://localhost:3000/sessions/{id}/orchestrator \
  -H "X-API-Key: dev" -H "Content-Type: application/json" \
  -d '{"task":"add a health check endpoint"}'
# → SSE stream con eventos del flow completo
```

**DoD:**
- OpenAPI spec en `/openapi.json`.
- Imagen Docker construible y corre.
- El stream SSE del orchestrator emite todos los eventos del flow en orden correcto.
- **Actualizar el README raíz** completando el paso 10 ("Use as a service") de la sección "Step-by-step usage guide" con los comandos `curl` reales y un ejemplo de payload de respuesta.
- Commit: `feat(server): HTTP/SSE with orchestrator endpoint`.

**📢 Post de LinkedIn:** *"chamba ahora corre como servicio. Puedes embeberlo en tu app web, dispararle el orchestrator desde un POST, y suscribirte a los eventos. SSE all the way."* Tema: por qué exponer un harness como servicio en vez de llamar al SDK directo.

---

### Fase 8.5 — `@chamba/mcp` (chamba como MCP server) 📢

**Estado:** ⏳ Pendiente

**Goal:** chamba se puede invocar desde el chat de Cursor, VS Code con Copilot, Windsurf, Cline, JetBrains, Trae y cualquier editor con MCP client. El usuario no instala una extensión — añade una entrada en el archivo de config MCP de su editor y queda disponible. Mismo patrón que usaste con lapzo-tools.

**Por qué importa:** sin esta fase, chamba vive solo en su propia terminal. Con esta fase, chamba se vuelve **una capa que vive transversalmente en cualquier flujo donde ya estés trabajando** — pides cosas a chamba desde donde tengas el cursor parpadeando, no tienes que cambiar de ventana.

**Entregables:**

- `packages/mcp/src/server.ts` — instancia un MCP server usando `@modelcontextprotocol/sdk` (`StdioServerTransport`). Se compone internamente de un `Harness` de `@chamba/core` con workspace cargado y los sub-agentes registrados.

- **Tools expuestas vía MCP** (cada una con su schema Zod claro):
  - `chamba_orchestrate({ task, mode })` — dispara el flow completo del orchestrator. `mode` puede ser `'plan-only'` (devuelve plan sin ejecutar), `'execute'` (planifica + ejecuta), `'execute-with-approval'` (planifica, espera approval via prompt-tool, ejecuta).
  - `chamba_workspace_init({ root? })` — inicializa workspace.md en el dir actual o el path especificado.
  - `chamba_workspace_show()` — devuelve el workspace.md actual como string.
  - `chamba_workspace_reload()` — re-escanea y devuelve diff propuesto.
  - `chamba_summarize_to_vault({ title, content, projectSlug? })` — escribe nota estructurada al vault.
  - `chamba_generate_plan({ task })` — solo genera plan, no ejecuta. Útil para que el editor pida un plan y el humano decida cómo seguir.

- `packages/mcp/bin/chamba-mcp` — shebang script que arranca el server en modo stdio. Es lo que los editores invocan como `command`.

- **Configuraciones de ejemplo** en `examples/editor-integration/` con README específico por editor:
  - `cursor.mcp.json` — para `.cursor/mcp.json`:
    ```json
    {
      "mcpServers": {
        "chamba": {
          "command": "npx",
          "args": ["-y", "@chamba/mcp"],
          "env": {
            "ANTHROPIC_API_KEY": "${ANTHROPIC_API_KEY}",
            "CHAMBA_WORKSPACE_ROOT": "${workspaceFolder}"
          }
        }
      }
    }
    ```
  - `vscode.mcp.json` — para `.vscode/mcp.json` (campo `"servers"` en vez de `"mcpServers"`, esta diferencia agarra a todos).
  - `windsurf.config.md` — instrucciones.
  - `jetbrains.config.md` — instrucciones.
  - `trae.config.md` — instrucciones con disclaimer de "compatible si Trae soporta MCP, verificar al usar".

- **Documentación de cada tool** en `packages/mcp/README.md` con ejemplos de invocación desde cada editor:
  - En Cursor: `@chamba orchestrate "agrega health check endpoint"`.
  - En VS Code Copilot Chat (Agent mode): `#chamba_orchestrate add a health check endpoint`.
  - En Windsurf/Cline: análogo.

- **Configuración por workspace.** El server descubre el workspace del editor automáticamente vía variable de entorno (`CHAMBA_WORKSPACE_ROOT`) que el editor expone. Si no está, usa `process.cwd()`.

- **Logging seguro.** Los MCP servers stdio no pueden escribir a stdout (rompe el protocolo). Logs van a `~/.chamba/logs/mcp-{pid}.log` con `pino`.

- **Tests:**
  - El MCP server arranca, declara las tools correctas con sus schemas.
  - Una llamada a `chamba_orchestrate` con MockProvider devuelve un resultado válido.
  - El server maneja correctamente la cancelación (signal) cuando el editor cierra la conexión.
  - Sin escribir a stdout fuera del protocolo MCP.

**Acceptance criteria:**
```bash
# 1. Build y publish local
pnpm --filter @chamba/mcp build
pnpm pack --filter @chamba/mcp

# 2. Smoke manual con MCP Inspector (oficial de Anthropic):
npx @modelcontextprotocol/inspector npx @chamba/mcp
# El inspector debe mostrar las 6 tools listadas correctamente.

# 3. Smoke manual con Cursor:
# - Crear .cursor/mcp.json en un repo dummy con la config de ejemplo
# - Abrir Cursor, abrir el chat, escribir: "@chamba show me the workspace"
# - Debe invocar chamba_workspace_show y devolver el contenido

# 4. Smoke manual con VS Code Copilot (si tienes acceso):
# - .vscode/mcp.json con la config de ejemplo
# - Abrir Copilot Chat en Agent mode
# - "#chamba_workspace_show"
# - Aprobar el dialog de confirmación
# - Debe devolver el workspace.md
```

**DoD:**
- El paquete `@chamba/mcp` se publica como binario invocable con `npx @chamba/mcp`.
- Configuración funciona en al menos **Cursor + VS Code Copilot** verificada manualmente. El resto de editores (Windsurf, Cline, JetBrains, Trae) se documentan con disclaimer "compatible vía MCP estándar; reportar issue si algo falla".
- El MCP server **no rompe el protocolo escribiendo a stdout** (verificar con MCP Inspector).
- **Actualizar el README raíz** añadiendo el paso 11 ("Use chamba from your editor") de la sección "Step-by-step usage guide" con instrucciones específicas por editor.
- Commit: `feat(mcp): expose chamba as MCP server for editor integration`.

**📢 Post de LinkedIn:** *"chamba ahora vive dentro de Cursor, VS Code y demás. Le hablas desde el chat de tu editor y dispara el orchestrator completo sin abrir terminal."* Tema: cómo MCP convierte cualquier herramienta CLI en algo invocable desde tu editor favorito. **Este post tiene alta probabilidad de pegar fuerte** porque cualquier dev que use Cursor lo entiende inmediatamente.

---

### Fase 9 — Release 1.0.0 + push de tracción 📢📢📢

**Estado:** ⏳ Pendiente

**Goal:** publicar en npm, pulir README, lanzar campaña de visibilidad.

**Entregables:**
- README.md raíz completo en inglés:
  - Hero con tagline en una línea.
  - GIF de la CLI funcionando con `/orq`.
  - "Why chamba?" con 4-5 bullets diferenciadores (incluir workspace-awareness y orchestrator-worker como destacados).
  - **Sección "Step-by-step usage guide"** — la guía obligatoria que tiene que estar sí o sí. Debe cubrir, en orden, cada uno de estos pasos con comandos exactos y output esperado:
    1. **Install** — `npm install -g @chamba/cli` (o `npx chamba` sin instalar).
    2. **Configure API keys** — crear `~/.chamba/config.json` con `ANTHROPIC_API_KEY` u `OPENAI_API_KEY`. Mostrar el JSON completo de ejemplo.
    3. **Run for the first time** — `chamba` arranca el REPL. Decir qué se ve y qué se puede preguntar primero.
    4. **Initialize workspace** — `/workspace init` escanea el directorio, genera `.chamba/workspace.md`, lo abre en `$EDITOR` para revisión. Explicar qué pone chamba ahí y cómo editarlo.
    5. **(Optional) Connect Obsidian vault** — añadir el bloque MCP de `obsidian-mcp` al `config.json` con ejemplo. Decir cómo verificar que conectó (`/tools` muestra las tools del vault).
    6. **Have a basic conversation** — ejemplo concreto de pedir algo simple ("list files in this dir") y mostrar el flow de approval prompt.
    7. **Run the orchestrator** — el ejemplo estrella. `/orq "add a health check endpoint"` y narrar paso a paso lo que pasa: contexto se carga, plan se genera, reviewer audita, humano aprueba, workers ejecutan en paralelo, tester valida, summary aparece en el vault (si hay) o en consola.
    8. **Switch provider mid-conversation** — `/provider openai` y mostrar que sigue funcionando.
    9. **Use as a library** — bloque de código TypeScript con `import { Harness } from '@chamba/core'` mínimo (10-15 líneas) creando una instancia y mandando un mensaje.
    10. **Use as a service** — `chamba serve` levanta el server, ejemplo de `curl` para crear sesión + mandar mensaje. Link al `openapi.json`.
    11. **Use chamba from your editor** — configurar chamba como MCP server en Cursor (`.cursor/mcp.json`), VS Code con Copilot (`.vscode/mcp.json`), Windsurf, Cline, JetBrains, Trae. Mostrar el JSON de config exacto por editor, cómo invocar `chamba_orchestrate` desde el chat de cada uno, y screenshots o snippets de resultado. **Esta es la sección que más conversiones va a generar** porque la mayoría de devs viven dentro de Cursor o VSCode hoy.
    12. **Customize agents** — cómo editar los `.md` de `.chamba/agents/` (orchestrator, reviewer, implementer, tester) para ajustar a tu workspace. Ejemplo concreto: añadir una regla al orchestrator tipo "always check existing patterns first".
    13. **Common issues** — al menos 4 troubleshooting comunes: API key no detectada, MCP server no conecta, permission policy bloqueando algo, editor no detecta chamba como MCP server.
  - "How it works" con diagrama del flow completo (workspace → orchestrator → reviewer → workers → tester → vault).
  - Comparison table vs Claude Code, OpenCode, Aider, LangChain.
  - Roadmap.
  - Badges (npm version, downloads, CI status, license).
- `README.es.md` — versión completa en español, incluyendo la **misma sección de paso a paso traducida**. No es traducción literal; adaptar ejemplos al español natural latino.
- `CHANGELOG.md` generado por changesets.
- Release de `0.1.0` o `1.0.0-rc.1` en npm (los 4 paquetes).
- Posts preparados para:
  - LinkedIn (español, audiencia LATAM dev).
  - X/Twitter (inglés, audiencia global).
  - Hacker News (Show HN: chamba).
  - Reddit r/LocalLLaMA y r/programming.
  - dev.to artículo largo explicando harness engineering con chamba como ejemplo, incluyendo el patrón workspace-aware.
  - r/ObsidianMD — post específico mostrando la integración con vaults.

**Acceptance criteria:**
```bash
npm view @chamba/core             # Muestra info real del paquete
npm view @chamba/cli
npm view @chamba/server
npx chamba                        # Funciona desde npm sin clonar nada
```

**DoD:**
- README pasa el "5-second test": un visitante entiende qué es y por qué importa en 5 segundos.
- **El step-by-step funciona literal**: alguien que no haya tocado chamba antes puede seguir los 12 pasos sin pegarse en ninguno. Para validarlo, en una VM o container limpio, ejecutar los pasos uno por uno y confirmar que cada uno produce el output documentado. Cualquier paso que falle, se arregla antes de publicar.
- Star count inicial registrado (baseline).
- Commit: `chore: release 0.1.0`.

**📢 Posts simultáneos:**
- LinkedIn: post largo en español contando el journey de las 9 fases.
- X: hilo en inglés con el GIF.
- Hacker News: "Show HN: chamba — TypeScript AI agent harness with workspace-aware orchestrator and first-class MCP".
- dev.to: artículo técnico de profundidad.
- r/ObsidianMD: post de "use Obsidian as memory for your AI agent".

---

## 6. Fuera de scope de V1

Para evitar feature creep. Cada uno puede ser V2.

- **Streaming de tokens dentro del agent loop.** V1 espera response completo. Streaming va en V1.5.
- **Prompt caching de Anthropic.** Va cuando el coste duela.
- **Web UI separada del CLI.** El server expone HTTP; cualquier frontend habla con él.
- **Modelos locales (Ollama, llama.cpp).** Nuevo provider, trivial arquitectónicamente, no V1.
- **Persistencia de sesiones en DB.** V1 en memoria. La estructura permite adapter después.
- **Marketplace de tools.** Interface listo, no hay UI.
- **OpenTelemetry tracing.** Event bus listo, instrumentación va después.
- **Multi-tenancy en server.** Hoy single-API-key.
- **Agent Teams con mailbox peer-to-peer.** Subagent V1 es jerárquico. Mailbox horizontal va en V2.
- **Auto-update del workspace.md basado en cambios del dir.** V1 requiere `/workspace reload` manual.
- **Búsqueda semántica vectorial en el vault.** V1 usa búsqueda por keywords vía MCP. Embeddings va en V2.
- **Integración con otras herramientas de notas** (Logseq, Notion, etc.). V1 enfocado en Obsidian. Otras vienen después.

---

## 7. Anexo A — CLAUDE.md sugerido

> **Claude Code:** este archivo va en la raíz del repo. Es tu contexto persistente en cada sesión.

```markdown
# chamba — Contexto de proyecto

## Qué es
chamba es un AI agent harness open-source en TypeScript. Monorepo pnpm con:
- `@chamba/core` — librería pura, sin Node APIs directas
- `@chamba/adapters` — implementaciones Node de los ports
- `@chamba/cli` — TUI con Ink, binario `chamba`
- `@chamba/server` — HTTP/SSE con Hono

Side project público, MIT, busca tracción en GitHub y npm. Inspirado en byo-coding-agent (BettaTech), Claude Code, OpenCode, Aider.

**Diferenciadores clave:**
- Provider-agnóstico desde día uno.
- MCP de primera clase.
- Workspace-aware: entiende el directorio donde corre y opcionalmente integra con vault de Obsidian.
- Orchestrator-worker con reviewer integrado.

## Principios no-negociables
Lee PLAN.md sección 2. Los 10 principios son ley.

## Cómo trabajamos
- Una fase del PLAN a la vez. No saltarse fases.
- Tests verdes antes de cualquier commit.
- Commits con conventional commits format.
- Si tienes que romper un principio, primero pregunta.
- Si una decisión de diseño no está en PLAN.md ni acá, pregunta antes de improvisar.

## Tracking de progreso (importante)
Cuando termines una fase debes:
1. Actualizar el campo `**Estado:**` de esa fase en PLAN.md de `⏳ Pendiente` a `✅ Completada — YYYY-MM-DD — {sha-corto}`.
2. Actualizar la fila correspondiente en la tabla "Estado de las fases" del inicio del documento.
3. Al iniciar una fase, marcar ambos lugares como `🚧 En progreso`.
4. Si te quedas bloqueado, marcar `❌ Bloqueada` y poner razón breve en la celda de fecha.
5. Ambas ubicaciones (campo `**Estado:**` y tabla) deben estar siempre sincronizadas.
6. El commit que cierra una fase debe incluir el update a PLAN.md como parte del mismo commit.

## Actualizaciones incrementales al README
El README crece fase por fase, no se escribe entero en Fase 9. Cada fase que añade capacidad visible al usuario debe actualizar la sección "Step-by-step usage guide" del README según el DoD de esa fase. Fase 9 solo pule, no escribe de cero.

## Stack confirmado
- Node 22 LTS, TypeScript 5.6+
- pnpm workspaces
- vitest, biome, tsup
- hono, ink, zod, neverthrow, pino
- @anthropic-ai/sdk, openai, @modelcontextprotocol/sdk
- NO uses: NestJS, LangChain, Mastra, Vercel AI SDK, ESLint+Prettier

## Comandos comunes
- `pnpm install`
- `pnpm -r build`
- `pnpm -r test`
- `pnpm --filter @chamba/core test`
- `pnpm biome check .`
- `pnpm biome check --write .`
- `pnpm changeset` — registrar cambio para release
- `pnpm changeset version` — bump versions
- `pnpm changeset publish` — release a npm

## Convenciones de código
- Exports nombrados, no default (excepto `bin/chamba`).
- Archivos kebab-case: `agent-loop.ts`.
- Tipos e interfaces PascalCase.
- Funciones y variables camelCase.
- Constantes globales SCREAMING_SNAKE_CASE.
- Errores son clases extendiendo `Error` con `name` explícito.
- Cero `any` excepto en adapters de SDKs externos, justificado.

## Estructura de tests
- Co-located: `agent-loop.test.ts` junto a `agent-loop.ts`.
- Sufijo `.test.ts`.
- Usar `MockProvider` para todo lo que no sea test de provider real.
- Smoke tests con API real van en `scripts/smoke-*.ts`, no en `test/`.

## Cuándo preguntar al humano
- Antes de saltarse fases del plan.
- Antes de añadir dependencias no listadas en PLAN.md sección 4.
- Antes de violar uno de los principios de PLAN.md sección 2.
- Antes de modificar este CLAUDE.md o PLAN.md.
- Si los acceptance criteria fallan después de 2 intentos honestos.

## Tono del proyecto (importante para README y docs)
- chamba es un proyecto LATAM, sin pena. README en inglés y español.
- Tono claro, directo, sin marketing-bullshit.
- En español, voseo o tuteo neutral. Sin chilenismos ni mexicanismos exclusivos.
- En inglés, técnico pero accesible. Sin "revolutionize", "leverage", "synergy".
```

---

## 8. Checklist de validación final (post-V1)

Los 5 ejercicios de bettatech traducidos a chamba + 3 ejercicios específicos del workspace/orchestrator/worktrees. Si los 8 pasan, el harness está realmente vivo, extensible y consciente del contexto.

- [ ] **E1.** Añadir un tool `git_diff` siguiendo el patrón de `read-file.ts`. Verificar que aparece en `/tools` y el modelo lo invoca.
- [ ] **E2.** Añadir una `CompactionStrategy` llamada `TokenBudget` que descarta mensajes antiguos hasta estar bajo un umbral configurable.
- [ ] **E3.** Añadir una `PermissionPolicy` llamada `AskOnlyForDangerous` que aprueba automáticamente `read_*` y `grep`, y pide aprobación solo para `bash` y `write_*`.
- [ ] **E4.** Añadir un tercer provider (sugerido: Ollama local). Sin tocar agent-loop ni tools.
- [ ] **E5.** Test e2e simulando conversación de 5 turnos con tool calls, con `MockProvider`, sin tocar APIs reales.
- [ ] **E6.** Configurar un vault Obsidian de pruebas, correr `/workspace init`, después `/orq "documenta el patrón observer"`. Verificar que el plan cita notas del vault y que el resumen final aparece como nota nueva.
- [ ] **E7.** Customizar el reviewer con un system prompt específico (ej: "eres muy estricto con seguridad") y verificar que rechaza planes que serían aprobados por el reviewer default.
- [ ] **E8.** En un repo git limpio, correr `/orq "crea endpoints health, metrics y version en paralelo"`. Verificar: (a) se crean 3 worktrees en `.chamba/worktrees/`, (b) cada worker trabaja en su propio worktree sin pisar a los otros, (c) al terminar las 3 ramas quedan abiertas (no merged, no borradas), (d) el summary lista las ramas con los comandos `git merge` sugeridos. Después correr el mismo `/orq` en un directorio NO git y verificar que el orchestrator detecta y delega serialmente.

Si los 8 pasan: hay harness real, agnóstico, extensible, testeable, workspace-aware, con orchestrator-worker funcional y aislamiento real por worker. Y construiste material para 8 posts adicionales en LinkedIn ("cómo añadir un X a chamba").

---

**Fin del plan.** Cualquier ambigüedad, pregunta antes de improvisar.
