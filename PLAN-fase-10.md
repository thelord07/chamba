# PLAN — Fase 10: Configuración por-agente (modelo + esfuerzo)

> **Borrador para revisión.** Este archivo NO es `PLAN.md`. Es la propuesta de Fase 10
> en el mismo formato y nivel de detalle que las fases existentes. Lo revisás, ajustás,
> y cuando lo apruebes lo mergeo como `### Fase 10` dentro de `PLAN.md` (y agrego su fila
> a la tabla "Estado de las fases").
>
> Estructurada en **5 sub-fases (10.1–10.5)** ejecutables una a una, con tests verdes y
> commit por sub-fase, igual que el resto del proyecto.

---

## Resumen de la fase

Añadir a chamba un **sistema de configuración por-agente** que deja al usuario elegir qué
**modelo** y qué **nivel de esfuerzo** se usa para cada **rol** (orchestrator, planner,
reviewer, implementer, tester, summarizer, researcher), con **defaults eficientes
pre-configurados** y override por proyecto.

**Esto NO viola el principio #1 (chamba no llama LLMs).** chamba sigue sin invocar ningún
modelo. La config es **metadata declarativa** que:

1. En **Claude Code** (`@chamba/claude-extras`): se materializa en el frontmatter `model:`
   y `effort:` de los subagents en `~/.claude/agents/*.md`. Quien ejecuta el modelo es
   Claude Code, no chamba.
2. En **el resto de editores**: se expone vía la tool MCP `chamba_get_agent_config`, que
   devuelve *hints* que el modelo del editor puede leer para decidir cómo delegar. chamba
   solo devuelve datos; el editor decide.

chamba nunca lee una API key, nunca abre un socket a un proveedor, nunca importa un SDK de
LLM. Solo declara preferencias.

---

## Decisión de diseño central: el `effort` abstracto y su mapeo por proveedor

El prompt original define el enum `effort` como `low | medium | high | extreme`. La
verificación contra la doc oficial mostró que **cada proveedor usa un vocabulario
distinto** de esfuerzo/thinking, así que `effort` de chamba es un **enum abstracto** que se
**mapea por proveedor** en el catálogo:

| `effort` chamba | Claude Code (`effort:`) | OpenAI (`reasoning_effort`) | Gemini 3.x (`thinkingLevel`) | Ollama |
|---|---|---|---|---|
| `low`      | `low`    | `low`    | `low`    | (n/a — boolean por modelo) |
| `medium`   | `medium` | `medium` | `medium`* | (n/a) |
| `high`     | `high`   | `high`   | `high`   | (n/a) |
| `extreme`  | `max`    | `xhigh`  | `high`** | (n/a) |

> \* Gemini 3.1-pro-preview solo soporta `low | high`; para ese modelo `medium`→`high`.
> \*\* Gemini no tiene un nivel por encima de `high`, así que `extreme`→`high` ahí.
> Ollama no tiene niveles de esfuerzo: el "thinking" es propiedad del modelo (ej.
> `deepseek-r1` siempre razona). Para Ollama, `effort` se ignora con un warning informativo.

**Por qué un enum abstracto y no el de Claude Code directo:** chamba es multi-editor. Si
acoplamos `effort` a `low|medium|high|xhigh|max` (vocabulario de Claude Code), rompemos la
abstracción para OpenAI/Gemini. El enum abstracto de 4 niveles es el mínimo común
denominador semántico, y el catálogo traduce. El frontmatter de Claude Code recibe el
valor traducido (`extreme`→`max`), nunca el abstracto.

**Hallazgo importante (corrige el prompt):** Claude Code **sí** tiene un campo de esfuerzo
en el frontmatter de subagents — se llama **`effort`** (valores `low|medium|high|xhigh|max`),
no `thinking`. **No existe** un campo `thinking` ni `thinkingBudget`. El campo `model:`
acepta IDs completos (`claude-opus-4-8`) o alias (`opus|sonnet|haiku`). Fuente:
`https://code.claude.com/docs/en/sub-agents.md`, secciones "Supported frontmatter fields" y
"Choose a model".

---

## Sub-fase 10.1 — Fundamentos del config en `@chamba/core`

**Estado:** ⏳ Pendiente

**Goal:** la única fuente de verdad sobre roles, modelos, defaults y resolución del config.
Cero Node APIs directas (todo IO vía `FilesystemPort`), cero llamadas a LLM, cero deps
nuevas (solo `zod`, que ya se usa en el repo).

**Entregables:**

- `packages/core/src/config/roles.ts`
  - `type AgentRole = 'orchestrator' | 'planner' | 'reviewer' | 'implementer' | 'tester' | 'summarizer' | 'researcher'`
  - `const AGENT_ROLES: readonly AgentRole[]` — orden canónico (el del wizard).
  - `type Effort = 'low' | 'medium' | 'high' | 'extreme'`
  - `const EFFORT_LEVELS: readonly Effort[]`
  - `type ReasoningPriority = 'speed' | 'balanced' | 'thoroughness'`

- `packages/core/src/config/types.ts`
  - `type AgentConfig = { model: string; effort: Effort; reasoning_priority: ReasoningPriority }`
  - `type ChambaConfig = { version: 1; defaults: Record<AgentRole, AgentConfig>; overrides?: Partial<Record<AgentRole, Partial<AgentConfig>>> }`
  - `type ResolvedConfig = Record<AgentRole, AgentConfig>` (todo resuelto, sin opcionales).

- `packages/core/src/models/catalog.ts` — **única fuente de verdad de qué modelos existen.**
  - `type ModelProvider = 'anthropic' | 'openai' | 'google' | 'ollama'`
  - ```ts
    type ModelInfo = {
      id: string;                 // ej. "claude-opus-4-8"
      provider: ModelProvider;
      label: string;              // ej. "Claude Opus 4.8"
      description: string;        // una línea, para el wizard
      supports_thinking: boolean;
      // mapeo effort abstracto -> valor nativo del proveedor (null = ignora effort)
      effortMap: Record<Effort, string | null>;
    };
    ```
  - `const MODEL_CATALOG: readonly ModelInfo[]` con los modelos verificados (jun 2026):

    | id | provider | thinking | notas |
    |---|---|---|---|
    | `claude-opus-4-8` | anthropic | sí | flagship reasoning |
    | `claude-opus-4-7` | anthropic | sí | reasoning anterior, vigente |
    | `claude-sonnet-4-6` | anthropic | sí | balanceado, rápido |
    | `claude-haiku-4-5` | anthropic | sí | barato, mecánico |
    | `gpt-5.5` | openai | sí | flagship; `reasoning_effort` none/low/medium/high/xhigh |
    | `gpt-5.5-mini` | openai | sí | ejecución rápida (xhigh sin confirmar → mapea a high) |
    | `gemini-3.1-pro-preview` | google | sí | flagship; `thinkingLevel` low/high |
    | `gemini-3.5-flash` | google | sí | GA rápido; `thinkingLevel` minimal/low/medium/high |
    | `qwen2.5-coder:7b` | ollama | no | coding local; effortMap todo `null` |
    | `deepseek-r1:7b` | ollama | sí | reasoning local; thinking siempre on |
    | `llama3.1:8b` | ollama | no | general local |

  - Helpers: `getModel(id): ModelInfo | undefined`, `modelsByProvider(p): ModelInfo[]`,
    `resolveEffort(model: ModelInfo, effort: Effort): string | null` (aplica `effortMap`).
  - **TODO marcado en el código (no inventar):** confirmar `gpt-5.5-mini` soporte de
    `xhigh` y que `gemini-3.1-pro-preview` siga siendo el Pro vigente al momento de build.
    Comentario `// TODO(catalog): verify before each release` arriba del array.

- `packages/core/src/config/defaults.ts` — **defaults hardcoded** (decisión confirmada).
  - `const DEFAULT_CONFIG: ChambaConfig` con la tabla razonada:

    | Rol | Modelo | Effort | reasoning_priority | Por qué |
    |---|---|---|---|---|
    | orchestrator | `claude-opus-4-8` | high | thoroughness | El cerebro: descompone y decide. |
    | planner | `claude-opus-4-8` | extreme | thoroughness | Máximo razonamiento; se invoca poco. |
    | reviewer | `claude-opus-4-7` | high | thoroughness | Audita con criterio; no necesita el último modelo. |
    | implementer | `claude-sonnet-4-6` | medium | balanced | Ejecuta specs claras; velocidad importa. |
    | tester | `claude-sonnet-4-6` | medium | balanced | Tests sobre código ya hecho. |
    | summarizer | `claude-haiku-4-5` | low | speed | Resume; tarea mecánica, modelo barato. |
    | researcher | `claude-opus-4-7` | high | thoroughness | Investiga y sintetiza; razonamiento alto. |

  - El `reasoning_priority` se deriva del rol pero es editable; se documenta el razonamiento
    en comentarios JSDoc (valor pedagógico).

- `packages/core/src/config/schema.ts` — validación Zod.
  - `agentConfigSchema`, `chambaConfigSchema` con `version: z.literal(1)`.
  - `model` se valida contra el catálogo: `.refine(id => getModel(id) !== undefined, ...)`
    con mensaje claro: `"unknown model 'x'; run 'chamba-config models' to list valid ids"`.
  - `effort` se valida contra `EFFORT_LEVELS`.
  - Export `parseChambaConfig(raw: unknown): Result<ChambaConfig, ConfigError>` usando
    `neverthrow` si se reintroduce, o un `{ ok, value | error }` plano para no añadir dep.
    **Decisión:** usar el patrón `{ ok, error }` plano (core no tiene runtime deps hoy;
    no reintroducir `neverthrow` solo para esto).

- `packages/core/src/config/loader.ts` — resolución y merge.
  - `class ConfigError extends Error { name = 'ConfigError' }` (convención del repo).
  - `async function loadConfig(fs: FilesystemPort, opts: { globalPath: string; projectPath?: string }): Promise<{ config: ResolvedConfig; sources: ConfigSource[] }>`
  - **Merge order (confirmado):** `DEFAULT_CONFIG` ← global (`~/.chamba/config.json`) ←
    project (`.chamba/config.json`). Project gana. Cada capa puede ser parcial:
    el merge es **por-rol y por-campo** (un project config que solo define
    `implementer.model` deja el resto en global/default).
  - Si un archivo existe pero es JSON inválido o falla el schema: **no crashear** — devolver
    los defaults compilados y un `ConfigSource` con `status: 'invalid'` y el mensaje de error,
    para que el CLI/tool lo muestre como warning. (Edge case "config corrupto" → degradar con
    aviso, nunca tumbar el server MCP.)
  - Si no existe ningún archivo: devolver `DEFAULT_CONFIG` resuelto, `sources: [{ kind:'default' }]`.

- `packages/core/src/config/resolve.ts`
  - `function resolveRole(config: ResolvedConfig, role: AgentRole): AgentConfig`
  - `function buildHint(role: AgentRole, cfg: AgentConfig): string` — genera la frase tipo
    *"Use a model optimized for deep reasoning; suggested: claude-opus-4-8 with high effort."*
    Determinística (sin LLM), basada en `reasoning_priority` + `effort` + `model`.

- Exports nuevos en `packages/core/src/index.ts` (barrel): roles, types, catalog helpers,
  `DEFAULT_CONFIG`, `loadConfig`, `parseChambaConfig`, `resolveRole`, `buildHint`,
  `ConfigError`.

**Tests (co-located, `*.test.ts`, `MemoryFilesystem`):**
- `catalog.test.ts` — todos los ids únicos; `effortMap` cubre los 4 niveles; helpers.
- `schema.test.ts` — acepta config válido; rechaza model desconocido, effort inválido,
  `version` distinto de 1, con mensajes claros.
- `defaults.test.ts` — `DEFAULT_CONFIG` pasa el schema; los 7 roles presentes; cada
  `model` existe en el catálogo.
- `loader.test.ts` — (a) sin archivos → defaults; (b) solo global → global mergeado;
  (c) global + project → project gana por-campo; (d) JSON corrupto → defaults + warning;
  (e) schema inválido → defaults + warning; (f) merge por-campo parcial.
- `resolve.test.ts` — `resolveRole`; `buildHint` produce frases estables por prioridad.

**Acceptance criteria:**
```bash
pnpm --filter @chamba/core build
pnpm --filter @chamba/core test    # todos verdes, incluidos los nuevos
pnpm biome check packages/core
```

**DoD:**
- core sigue sin runtime deps (zod es devDep de build/types; si se usa en runtime,
  documentar — ver nota abajo) y sin imports de Node APIs.
- `DEFAULT_CONFIG` es la única fuente de defaults; el catálogo la única de modelos.
- Commit: `feat(core): per-agent config — roles, model catalog, defaults, loader`.

> **Nota deps:** `zod` hoy está como devDependency en core (se removió de runtime en Fase 9).
> El schema de config necesita zod en runtime para validar al cargar. Dos opciones a decidir
> en ejecución: (a) volver a añadir `zod` como dependency de core, o (b) validar a mano sin
> zod (más código, cero dep). **Recomendación:** (a) — zod ya está en el árbol vía mcp, el
> costo es nulo y el repo ya lo usa. Lo marco como confirmación rápida, no bloqueante.

---

## Sub-fase 10.2 — Tool MCP `chamba_get_agent_config`

**Estado:** ⏳ Pendiente

**Goal:** exponer la config resuelta a **cualquier** editor MCP como una tool. Es la pieza
que hace esto multi-editor (no solo Claude Code).

**Entregables:**

- `packages/mcp/src/tools/get-agent-config.ts`
  - Input schema (Zod): `{ role: z.enum(AGENT_ROLES) }`.
  - Output schema: `{ role, model, effort, reasoning_priority, provider, hint }`.
  - Implementación: usa `loadConfig` con `globalPath = ~/.chamba/config.json` y
    `projectPath = <cwd>/.chamba/config.json` (vía `Services`), resuelve el rol, arma el
    `hint` con `buildHint`, y añade `provider` desde el catálogo.
  - Si el config global/project está corrupto: devolver defaults + un campo
    `warning?: string` en el output para que el modelo del editor lo sepa.
  - **No escribe nada.** Tool de solo lectura.

- Extender `packages/mcp/src/services.ts` si hace falta exponer `globalConfigPath()` /
  `projectConfigPath()` (probablemente derivables de `homedir`/`cwd` ya existentes — reusar).

- Registrar la tool en `packages/mcp/src/server.ts` (pasa a ser la **tool #13**).

- Actualizar el README (tabla de Tools) con `chamba_get_agent_config` — sub-fase 10.5 hace
  el grueso de docs, pero la fila de la tabla se añade aquí para mantener el invariante
  "cada fase que añade tools actualiza el README".

**Tests:**
- `get-agent-config.test.ts` (estilo de los tests de mcp existentes, `InMemoryTransport` +
  `Client`): invoca la tool por cada rol; verifica output shape; verifica que con un
  `.chamba/config.json` de override el resultado refleja el override; verifica defaults
  cuando no hay archivos; verifica `warning` con config corrupto.
- Actualizar `server.test.ts`: `tools expuestas: 13`.

**Acceptance criteria:**
```bash
pnpm --filter @chamba/core build && pnpm --filter @chamba/mcp build
pnpm --filter @chamba/mcp test
# Smoke con MCP Inspector:
npx @modelcontextprotocol/inspector --cli node packages/mcp/dist/main.js \
  --method tools/call --tool-name chamba_get_agent_config --tool-arg role=planner
# Esperado: { model: "claude-opus-4-8", effort: "extreme", reasoning_priority: "thoroughness", ... }
```

**DoD:**
- La tool aparece en `npx @chamba/mcp` (13 tools).
- Funciona sin ningún archivo de config (devuelve defaults).
- Commit: `feat(mcp): chamba_get_agent_config tool`.

---

## Sub-fase 10.3 — Generación de subagents desde el config (`apply`)

**Estado:** ⏳ Pendiente

**Goal:** que `~/.claude/agents/*.md` se generen a partir del config, inyectando
`model:` y `effort:` en el frontmatter. Hoy los agents son assets estáticos sin `model`;
pasan a ser **plantilla de cuerpo (system prompt) + frontmatter generado**.

**Diseño:**
- Los archivos en `packages/claude-extras/assets/agents/*.md` se quedan como **fuente del
  cuerpo** (el system prompt) + un frontmatter mínimo (`name`, `description`). Se añade un
  mapeo explícito archivo→rol:
  - `implementer.md` → rol `implementer`
  - `reviewer.md` → rol `reviewer`
  - `tester.md` → rol `tester`
  - (orchestrator/planner/summarizer/researcher: ver nota abajo)
- **Nota de alcance:** hoy claude-extras envía 3 subagents (implementer, reviewer, tester).
  Los 7 roles existen en el catálogo de config, pero solo generamos frontmatter para los
  subagents que realmente existen como archivo. orchestrator/planner viven en el slash
  command `/orq` (que es el "cerebro"), no como subagent file. **Decisión:** en V1 de la
  Fase 10 generamos `model:`+`effort:` para los 3 subagents existentes; el resto de roles
  quedan accesibles solo vía `chamba_get_agent_config` y el CLI. Documentar claramente.
  (Añadir subagents para los 4 roles restantes es trabajo opcional, lo dejo como TODO
  marcado, no como requisito de la fase.)

**Entregables:**
- `packages/claude-extras/src/agent-frontmatter.ts`
  - `function renderAgentMarkdown(body: string, name: string, description: string, cfg: AgentConfig): string`
  - Genera frontmatter YAML válido para Claude Code:
    ```yaml
    ---
    name: implementer
    description: ...
    model: claude-sonnet-4-6
    effort: medium
    ---
    ```
  - `effort` se traduce del abstracto al valor nativo de Claude Code vía
    `resolveEffort(getModel(cfg.model), cfg.effort)`. Si el modelo no es Anthropic
    (usuario puso un modelo OpenAI para un subagent de Claude Code), **omitir `model:`** y
    dejar `inherit` con un comentario, porque Claude Code no ejecuta modelos no-Anthropic.
    Edge case documentado.
  - El parsing del frontmatter existente en los assets se hace con un splitter simple de
    `---` (sin añadir una dep de YAML; el frontmatter es trivial y controlado por nosotros).

- `packages/claude-extras/src/installer.ts` (extender)
  - El install ahora, para la categoría `agents`, **renderiza** cada `.md` con el config
    resuelto en vez de copiarlo crudo.
  - Nuevo método `applyConfig(): Promise<ApplyResult>` que regenera solo los agents desde
    el config actual (idempotente: si el contenido no cambia, no reescribe; reporta
    `{ regenerated, unchanged }`).
  - Reusa el `loadConfig` de core con `globalPath = ~/.chamba/config.json`.

**Tests:**
- `agent-frontmatter.test.ts` — render con modelo Anthropic produce `model:`+`effort:`
  traducido; con modelo no-Anthropic omite `model:`; YAML válido; cuerpo intacto.
- `installer.test.ts` (extender) — `applyConfig` es idempotente (2ª corrida → todo
  `unchanged`); cambiar el config regenera; install renderiza frontmatter desde defaults.

**Acceptance criteria:**
```bash
pnpm --filter @chamba/claude-extras build && pnpm --filter @chamba/claude-extras test
# Verificación manual del frontmatter generado:
node packages/claude-extras/dist/cli.js apply
grep -A1 "^model:" ~/.claude/agents/implementer.md   # → claude-sonnet-4-6 / effort: medium
```

**DoD:**
- `apply` regenera idempotentemente los 3 subagents con `model`+`effort` del config.
- Modelo no-Anthropic en un subagent → degrada a `inherit`, no rompe.
- Commit: `feat(claude-extras): generate subagent frontmatter from config (apply)`.

---

## Sub-fase 10.4 — Wizard interactivo + comando `chamba-config`

**Estado:** ⏳ Pendiente

**Goal:** UX de configuración. Wizard al instalar (no bloqueante) + un CLI `chamba-config`
para reconfigurar después.

**Decisión de dependencia (requiere tu OK — ver §"Preguntas abiertas"):** el prompt sugiere
`@inquirer/prompts`. No está en PLAN.md §4, así que es una **dep nueva** y por CLAUDE.md
debo confirmarla. Recomiendo `@inquirer/prompts` (mantenido, tree-shakeable, estándar de
facto para wizards de CLI en Node). Alternativa sin dep: prompts a mano con `node:readline`
(más código, peor UX de navegación). El plan asume `@inquirer/prompts`; si lo vetás, caigo
a `readline`.

**Entregables:**

- `packages/claude-extras/src/wizard.ts`
  - `async function runWizard(opts: { fs; configPath; nonInteractive?: boolean }): Promise<ChambaConfig>`
  - Flujo:
    1. Mensaje de bienvenida (qué hace, que no llama LLMs, que puede cambiarlo después).
    2. Pregunta raíz: **"¿Usar los defaults recomendados o customizar?"** (default:
       recomendados).
    3. Si customiza: por cada `AgentRole` en orden canónico, mostrar:
       `<<rol>> — <una línea de qué hace>`, lista de modelos del catálogo (label +
       description), y luego el `effort` (filtrado a los soportados por ese modelo).
       Pre-seleccionar el default del rol.
    4. Resumen final en tabla (rol → model · effort) y confirmación.
    5. Escribir `~/.chamba/config.json` (crea `~/.chamba/` si no existe, vía FS port).
  - **No bloqueante:** si el usuario hace Ctrl+C / cancela, **no** escribir archivo, instalar
    con defaults compilados, y avisar: *"Wizard cancelado. Usando defaults. Corré
    `npx @chamba/claude-extras config wizard` cuando quieras."* (capturar el
    `ExitPromptError` de inquirer / SIGINT y continuar).
  - **Modo no-interactivo (`nonInteractive: true` / `--defaults`):** escribe defaults sin
    preguntar nada. Para CI y para el flag de install.

- Integración en `packages/claude-extras/src/cli.ts` (install):
  - Primera vez (no existe `~/.chamba/config.json`) y stdin es TTY → correr el wizard antes
    de instalar, luego `applyConfig`.
  - Si `--defaults` o stdin no-TTY (CI) → saltar wizard, usar defaults, instalar.
  - Tras el wizard, install procede normal y aplica el frontmatter generado.

- Nuevo bin/comando `chamba-config`:
  - `packages/claude-extras/bin/chamba-config` (`#!/usr/bin/env node` → `../dist/config-cli.js`).
  - Añadir a `package.json` `bin`: `"chamba-config": "./bin/chamba-config"`.
  - `packages/claude-extras/src/config-cli.ts` con subcomandos:
    - `chamba-config show` — imprime la config resuelta (default/global/project) y de dónde
      viene cada valor. Marca si hay override de proyecto.
    - `chamba-config models` — lista el catálogo (id, provider, thinking, effort soportado).
    - `chamba-config wizard` — re-lanza `runWizard`.
    - `chamba-config edit` — abre `~/.chamba/config.json` en `$EDITOR` (fallback: imprime la
      ruta si no hay `$EDITOR`). Si el archivo no existe, lo crea con defaults primero.
    - `chamba-config set <role> <model> [--effort <e>]` — valida contra el catálogo, escribe
      el cambio puntual en `~/.chamba/config.json` (mergeando, no sobrescribiendo el resto).
    - `chamba-config reset` — reescribe `~/.chamba/config.json` con `DEFAULT_CONFIG` (pide
      confirmación salvo `--yes`).
    - `chamba-config apply` — llama `installer.applyConfig()` (regenera subagents).
  - Errores claros: model inválido → lista sugerencias; rol inválido → lista roles válidos.

**Tests:**
- `wizard.test.ts` — modo `nonInteractive` produce `DEFAULT_CONFIG` y escribe el archivo;
  (la rama interactiva se testea inyectando un mock de las funciones de prompt, o se deja la
  lógica pura de "armar config a partir de respuestas" en una función testeable
  `buildConfigFromAnswers(answers): ChambaConfig` separada de la UI).
- `config-cli.test.ts` — `set` valida y mergea; `reset` restaura defaults; `show` refleja
  override de proyecto; `set` con model inválido falla con mensaje claro y exit code ≠ 0.

**Acceptance criteria:**
```bash
pnpm --filter @chamba/claude-extras build && pnpm --filter @chamba/claude-extras test

# No-interactivo (CI):
node packages/claude-extras/dist/cli.js install --defaults
cat ~/.chamba/config.json    # defaults escritos

# Cambiar un agente sin re-correr el wizard:
node packages/claude-extras/dist/config-cli.js set implementer claude-haiku-4-5 --effort low
node packages/claude-extras/dist/config-cli.js show     # implementer ahora haiku/low
node packages/claude-extras/dist/config-cli.js apply    # regenera ~/.claude/agents
grep "^model:" ~/.claude/agents/implementer.md          # claude-haiku-4-5

# Reset:
node packages/claude-extras/dist/config-cli.js reset --yes
```

**DoD:**
- Wizard corre al instalar la 1ª vez; Ctrl+C no rompe la instalación (cae a defaults).
- `--defaults` y entorno no-TTY nunca piden input (CI-safe).
- `chamba-config {show,models,wizard,edit,set,reset,apply}` funcionan.
- Commit: `feat(claude-extras): config wizard + chamba-config CLI`.

---

## Sub-fase 10.5 — Documentación + cierre de fase

**Estado:** ⏳ Pendiente

**Goal:** documentar el sistema con el valor pedagógico que pide el prompt (enseñar *por qué*
se reparten así los modelos) y cerrar la fase.

**Entregables:**

- `packages/claude-extras/README.md` — sección **"Configuration"**:
  - Qué es y la aclaración explícita de que **chamba no llama LLMs** (la config es metadata).
  - **Tabla de defaults razonados** (la de 10.1) con la columna "Por qué".
  - Walkthrough del wizard con salida de ejemplo (bloque de texto, no screenshot binario —
    igual que el GIF, los screenshots quedan como paso manual opcional para el usuario).
  - Cómo override por proyecto: ejemplo de `.chamba/config.json` con un solo agente
    customizado.
  - Tabla del **mapeo de `effort` por proveedor**.
  - **FAQ:** por qué tantos modelos distintos; cómo cambiar sin re-correr el wizard
    (`chamba-config set`); qué pasa si el config se corrompe (degrada a defaults); por qué
    `effort: extreme` se vuelve `max` en Claude Code; qué pasa con modelos no-Anthropic en
    subagents de Claude Code.

- `README.md` y `README.es.md` raíz:
  - Fila `chamba_get_agent_config` en la tabla de Tools (si 10.2 no la dejó completa).
  - Breve mención en "How it works" de que el modelo del editor puede preguntar
    `chamba_get_agent_config` para saber qué esfuerzo se espera por rol.
  - Roadmap: marcar la config por-agente como entregada.

- `examples/` (opcional, si aporta): un `.chamba/config.json` de ejemplo en
  `examples/claude-code-setup/` mostrando un override por proyecto.

**Acceptance criteria:**
```bash
pnpm -r build && pnpm -r test     # todo verde
pnpm biome check .                # limpio
# El README del paquete muestra la tabla de defaults y el FAQ.
```

**DoD:**
- README del paquete con sección Configuration completa (tabla razonada + FAQ + override).
- READMEs raíz reflejan la tool nueva (13 tools).
- **Changeset** registrado (`pnpm changeset`) describiendo la feature para el próximo release
  (probable `0.2.0` minor — feature nueva, sin breaking changes).
- Commit: `docs(claude-extras): document per-agent config + wizard`.

---

## Acceptance criteria de la Fase 10 (global)

```bash
# 1. Todo construye y testea verde:
pnpm -r build
pnpm -r test
pnpm biome check .

# 2. La tool MCP responde para todos los roles, sin config previa (defaults):
npx @modelcontextprotocol/inspector --cli node packages/mcp/dist/main.js \
  --method tools/call --tool-name chamba_get_agent_config --tool-arg role=orchestrator
# → opus-4-8 / high / thoroughness

# 3. El ciclo completo de config funciona:
node packages/claude-extras/dist/cli.js install --defaults     # escribe ~/.chamba/config.json
node packages/claude-extras/dist/config-cli.js set tester claude-haiku-4-5 --effort low
node packages/claude-extras/dist/config-cli.js apply
grep "^model:" ~/.claude/agents/tester.md                      # claude-haiku-4-5

# 4. La tool refleja el override por proyecto:
mkdir -p .chamba && echo '{"version":1,"overrides":{"reviewer":{"model":"claude-sonnet-4-6"}}}' > .chamba/config.json
npx @modelcontextprotocol/inspector --cli node packages/mcp/dist/main.js \
  --method tools/call --tool-name chamba_get_agent_config --tool-arg role=reviewer
# → model: claude-sonnet-4-6 (project override gana)

# 5. Config corrupto no tumba nada:
echo 'NOT JSON' > ~/.chamba/config.json
# la tool y el CLI siguen funcionando, devuelven defaults + warning
```

## DoD de la Fase 10

- [ ] core: roles, catálogo, defaults hardcoded, schema Zod, loader con merge por-campo,
      `buildHint`. Tests verdes. Sin imports de Node ni de LLM SDKs.
- [ ] mcp: tool `chamba_get_agent_config` registrada (13 tools), solo-lectura, tests verdes.
- [ ] claude-extras: render de frontmatter (`model`+`effort` traducido), `applyConfig`
      idempotente, wizard no-bloqueante, `chamba-config` con 7 subcomandos. Tests verdes.
- [ ] Edge cases cubiertos: config corrupto → defaults+warning; model fuera del catálogo →
      rechazado con mensaje claro; modelo no-Anthropic en subagent CC → `inherit`; Ctrl+C en
      wizard → install con defaults; entorno no-TTY → sin prompts.
- [ ] Docs: sección Configuration con tabla razonada + FAQ + override por proyecto.
- [ ] Changeset registrado.
- [ ] biome limpio en todo el repo.
- [ ] PLAN.md: Fase 10 marcada `✅ Completada` en tabla + campo Estado (commit que cierra).

---

## Cosas que quedaron como TODO / preguntas abiertas para tu revisión

1. **`@inquirer/prompts` (dep nueva, no en PLAN.md §4).** Requiere tu OK explícito por
   CLAUDE.md. Recomiendo aceptarla; alternativa es `node:readline` a mano. **← decisión tuya.**

2. **`zod` en runtime de core.** Hoy es devDep (se sacó de runtime en Fase 9). El schema de
   config lo necesita en runtime. Recomiendo re-añadirlo como dependency de core (costo nulo,
   ya está en el árbol). Alternativa: validación manual sin zod. **← confirmación rápida.**

3. **Subagents para los 7 roles.** Hoy existen 3 archivos (implementer, reviewer, tester).
   La Fase 10 genera frontmatter para esos 3; orchestrator/planner/summarizer/researcher
   quedan accesibles vía la tool MCP y el CLI, pero no como `agents/*.md`. Crear los 4
   archivos faltantes es trabajo opcional — lo dejé fuera del DoD. **← ¿querés los 7 como
   subagents en esta fase, o está bien diferirlo?**

4. **Verificación de catálogo pre-release.** `gpt-5.5-mini`+`xhigh` y
   `gemini-3.1-pro-preview` son targets móviles. Dejé `// TODO(catalog): verify before each
   release` en el código. No bloquea la fase.

5. **`reasoning_priority` ¿editable o derivado?** Lo dejé editable pero con default derivado
   del rol. Si preferís que sea siempre derivado (no configurable), es menos superficie de
   error. **← preferencia tuya.**

---

## Resumen ejecutivo (decisiones que tomé)

1. **Granularidad: 5 sub-fases (10.1–10.5).** core → tool MCP → generación de subagents →
   wizard+CLI → docs. Cada una con tests y commit propio, ejecutable sin re-pensar
   arquitectura. La alternativa (una sola Fase 10 monolítica) hacía el commit demasiado
   grande para el flujo fase-por-fase del proyecto.

2. **`effort` es un enum abstracto de 4 niveles (`low|medium|high|extreme`) mapeado por
   proveedor en el catálogo.** Esto preserva la abstracción multi-editor. La verificación
   reveló que cada proveedor usa vocabulario distinto, así que el mapeo vive en el catálogo
   (única fuente de verdad). `extreme`→`max` en Claude Code.

3. **Corrección al prompt sobre el frontmatter:** Claude Code usa el campo **`effort`**
   (no `thinking`) y acepta IDs completos en `model:`. No inventé un campo `thinking` que no
   existe. Verificado contra la doc oficial.

4. **Model IDs actualizados a los vigentes (jun 2026):** OpenAI `gpt-5.5`/`gpt-5.5-mini`
   (no `gpt-5`), Gemini `gemini-3.1-pro-preview`/`gemini-3.5-flash`, IDs Anthropic con
   guiones (`claude-opus-4-8`). Ollama con formato `name:tag` y `supports_thinking` por
   modelo. Targets móviles marcados como TODO de verificación pre-release.

5. **Defaults hardcoded en `core/src/config/defaults.ts`** (tu decisión), única fuente de
   verdad, override vía `~/.chamba/config.json`. El catálogo de modelos es otra fuente única
   en `core/src/models/catalog.ts`.

6. **Merge por-campo, no por-archivo:** project override puede definir solo
   `implementer.model` y el resto cae a global/default. Más granular que "project reemplaza
   global entero".

7. **Edge cases priorizados como first-class:** config corrupto → degrada a defaults +
   warning (nunca tumba el MCP server); model fuera del catálogo → rechazo con mensaje y
   sugerencias; modelo no-Anthropic en subagent de Claude Code → `inherit`; Ctrl+C en wizard
   → install igual con defaults; entorno no-TTY → cero prompts (CI-safe vía `--defaults`).

8. **UX del wizard:** pregunta raíz "defaults vs customizar" primero (la mayoría tomará
   defaults y termina en 1 paso); si customiza, recorre los 7 roles en orden canónico
   pre-seleccionando el default; resumen + confirmación; escribe `~/.chamba/config.json`.
   Lógica pura separada de la UI (`buildConfigFromAnswers`) para poder testear sin TTY.

9. **`chamba-config` como segundo bin** con 7 subcomandos (`show/models/wizard/edit/set/
   reset/apply`) para reconfigurar sin re-correr el wizard — cubre el "cómo cambio un solo
   agente" del FAQ.

10. **5 preguntas abiertas** te las dejé arriba: `@inquirer/prompts` (dep), `zod` en runtime
    de core, si querés los 7 roles como subagent files o diferir 4, `reasoning_priority`
    editable vs derivado, y la verificación de catálogo. Ninguna bloquea redactar; sí quiero
    tu input antes de ejecutar 10.4 (la dep) y 10.1 (zod).
