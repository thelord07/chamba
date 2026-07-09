# Plan — Paralelismo consciente de recursos (RAM/CPU)

> Estado: ✅ Completada — 0.12.0 (junto con el fix del doctor multi-repo). Respeta los 10 principios.

## Problema

El flujo `/ticket` multi-repo abre worktrees + subagentes `implementer` y `tester`
(y en la fase QA, dev servers) **en paralelo, uno por repo**. En una máquina de 8/16 GB,
N workers pesados a la vez (cada uno = proceso node + build + a veces un server) revientan
la RAM → thrashing/OOM. chamba debe **medir la máquina y presupuestar cuánto paralelismo
es seguro**, y que el orquestador lo respete (fan-out por oleadas en vez de todo de una).

## Reencuadre (principios)

- **No es un "agente observador" con LLM ni un daemon.** chamba no razona ni corre procesos
  de fondo. Es una **tool determinista** que mide recursos y devuelve un presupuesto; el
  **modelo del editor** (orquestador) la consulta antes de abrir el fan-out y decide. chamba
  aconseja, no fuerza — igual que el resto del producto.
- **Cero LLM:** medición (`node:os`) + aritmética pura. **Editor-agnóstico:** tool MCP +
  guía en los prompts. **No-destructivo.**

## Dónde se "guarda" (respondiendo tu instinto de meterlo en `.chamba`)

Medir en el `init` y volcar la RAM al `.chamba/workspace.md` **compartido** sería un bug:
ese archivo se comitea y viaja entre máquinas (finalis 64 GB vs laptop 8 GB) → quedaría
stale/erróneo. En su lugar:

- **Lectura en vivo** cada vez (fuente de verdad; la RAM libre fluctúa). 
- **Cap en config**, capa que sí tiene sentido persistir: `worktrees.maxParallel` y
  `worktrees.perWorkerMemMB` en `./.chamba/config.json` (por proyecto, compartible: "nunca
  más de 3") y/o `~/.chamba/config.json` (por máquina). `loadConfig` ya superpone global←proyecto.
- **`doctor` y la tool exponen** las specs detectadas para que las veas. (Cache opcional de
  un perfil de máquina en `~/.chamba/` — no necesario para v1.)

## Cambios

### A. Core — port + función pura de presupuesto
- **NUEVO `packages/core/src/ports/system.ts`**:
  ```ts
  export interface SystemResources { totalMemBytes: number; freeMemBytes: number; cpus: number; loadAvg1: number; }
  export interface SystemPort { resources(): SystemResources; }
  ```
- **NUEVO `packages/core/src/resources/budget.ts`** (puro):
  `computeConcurrencyBudget({ resources, requested?, perWorkerMemMB?=2048, reservedMemMB?=2048, cap? }) → ConcurrencyBudget`
  - `usableMem = max(0, freeMem − reserved)` → `memBudget = max(1, floor(usableMemMB / perWorkerMemMB))`
  - `cpuBudget = max(1, cpus − 1)` (deja un core al OS/editor)
  - penalización por carga: si `loadAvg1 ≥ cpus`, baja `cpuBudget` (clamp ≥1; loadavg=0 en Windows → sin penalización)
  - `recommended = clamp(min(memBudget, cpuBudget, cap ?? ∞, requested ?? ∞), 1)`
  - `limitedBy: 'memory'|'cpu'|'cap'|'requested'|'load'` + `reason` legible
    (ej: *"16 GB RAM (5.2 GB libres), 10 cores → hasta 3 workers en paralelo (limitado por memoria, ~1.5 GB c/u, 2 GB reservados)"*).
- **`budget.test.ts`**: 8 GB/4 cores → bajo; 64 GB/16 cores → limitado por cpu/requested; carga alta → reduce; cap respetado; nunca < 1.

### B. Adapters — implementación Node
- **NUEVO `packages/adapters/src/node-system.ts`** — `NodeSystem implements SystemPort` vía
  `os.totalmem()`, `os.freemem()`, `os.availableParallelism?.() ?? os.cpus().length`, `os.loadavg()[0]`.
  Export desde el index de adapters.

### C. Config — extender WorktreeConfig
- `packages/core/src/config/worktrees.ts`: agregar `maxParallel: number | null` y
  `perWorkerMemMB: number | null` (default `null` = auto), manejados en `resolveWorktreeConfig`.
- `schema.ts`/`types.ts`: validar los dos campos nuevos si el worktree config pasa por zod. Tests.

### D. MCP — services + tool nueva
- `packages/mcp/src/services.ts`: agregar `system: SystemPort`, wire `new NodeSystem()`.
  Tests inyectan un `FakeSystem`.
- **NUEVO `packages/mcp/src/tools/resource-budget.ts`** — `registerResourceBudget`.
  Input `{ requested?, perWorkerMemMB? }`. Lee config (overrides `worktrees.maxParallel`/
  `perWorkerMemMB`), llama `services.system.resources()`, computa y devuelve texto +
  `structuredContent { recommended, limitedBy, totalMemGB, freeMemGB, cpus, reason }`.
- Registrar en `server.ts`; sumar `chamba_resource_budget` al snapshot de `server.test.ts`.

### E. Doctor — línea informativa de specs
- `packages/core/src/doctor/doctor.ts`: check `system` (info/ok, **nunca fail**):
  *"16 GB RAM (5.2 GB libres), 10 cores → hasta N workers en paralelo"*. Agregar
  `resources: SystemResources` a `DoctorInput`, pasado desde la tool doctor + `main.ts`.
  Actualizar `doctor.test.ts`.

### F. create_worktrees — devolver el hint donde se decide el fan-out
- `chamba_create_worktrees`: tras crear N worktrees, computar el budget con `requested = N` y
  sumar `recommendedParallelism` + `reason` al `structuredContent`. Pone el número exactamente
  donde el orquestador arranca el fan-out (ergonómico; además de la tool suelta).

### G. claude-extras — orquestación por oleadas
- `assets/commands/ticket.md`: en el preámbulo "Orchestration capability" (o nota junto al
  paso 6), antes de abrir workers por repo, **consultar `chamba_resource_budget`** (o el hint
  de `create_worktrees`) con `requested = #repos`. Si `recommended < #repos`, correr
  implementer/tester en **oleadas de `recommended`** en vez de todo de una, y avisar el cap +
  por qué (una línea). Nunca excederlo. Igual para la fase QA si levanta varios dev servers.
- `assets/commands/orq.md` + rol `orchestrator`: mismo principio, más liviano.

### H. Docs (regla del proyecto: README/landing crecen por fase)
- README (EN/ES): fila `chamba_resource_budget` en la tabla de Tools + bullet de
  "paralelismo consciente de recursos" + línea de system en doctor.
- `docs/index.html`: `resource_budget` en la lista de tools + mención en beneficios.

## Verificación end-to-end
1. `pnpm -r build && pnpm -r test` verde (budget, config, doctor, server snapshot, services).
2. `chamba_resource_budget { requested: 5 }` en 8 GB/4 cores → recomienda 1–2 con `reason`.
3. `chamba doctor` muestra la línea de system.
4. Config: `worktrees.maxParallel: 2` → nunca recomienda más de 2 aunque haya RAM.
5. Flujo real: `/ticket` con 5 repos en máquina chica → corre en oleadas de N, avisa el cap.

## Decisiones (resueltas)
- **Estimado de RAM por worker: 2 GB** (`perWorkerMemMB`, configurable hacia abajo para
  stacks livianos). Conservador a propósito: el OOM es un fallo asimétricamente peor que
  correr un worker menos en paralelo.
- **Doble exposición:** tool suelta `chamba_resource_budget` **+** el número dentro de la
  salida de `create_worktrees` (donde se decide el fan-out). Ambas.

## Orden / release
- **Primero** el fix del doctor multi-repo (patch 0.11.2, ver 🐛 en BACKLOG).
- **Después** esto: minor (tool + port + config nuevos) → changeset `@chamba/core` +
  `@chamba/mcp` + `@chamba/claude-extras` (lockstep bumpea los 4) → **0.12.0**.
