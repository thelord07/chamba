<p align="center">
  <img src="./docs/chambalogo2.png" alt="chamba — tu CLI para generar proyectos" width="340" />
</p>

# chamba

[![npm](https://img.shields.io/npm/v/@chamba/mcp.svg)](https://www.npmjs.com/package/@chamba/mcp)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-7c3aed.svg)](https://modelcontextprotocol.io)

> **Un MCP server que le agrega orquestación, contexto de workspace, git worktrees y
> memoria con Obsidian a cualquier editor con IA** — Cursor, Claude Code, VS Code
> (Copilot), Windsurf, Cline, OpenCode, Zed, JetBrains, Gemini CLI, Codex, Trae, Kiro.
> Sin API key: el modelo de tu editor razona,
> chamba coordina.

*"Chamba"* es la palabra latina para *trabajo*. Vos le pasás la chamba al modelo;
chamba (la herramienta) se encarga de supervisar, validar y toda la plomería.

📖 [English](./README.md) · 🧩 [Guías de configuración por editor](./examples/) · 🗺️ [Roadmap](#roadmap)

> 🎉 **v0.11.1 en npm** — `npx @chamba/mcp`. Construido en público, fase por fase
> ([`PLAN.md`](./PLAN.md)). Pre-1.0: usable hoy, todavía evolucionando.

## La idea clave: chamba NO llama a un LLM

El modelo de tu editor hace el razonamiento y llama a las tools de chamba. Eso significa:

- **Cero API keys.** Nada de `ANTHROPIC_API_KEY` ni `OPENAI_API_KEY`.
- **Todos los editores con MCP, desde el día uno.** Un solo server stdio funciona en
  Cursor, Claude Code, VS Code, Windsurf, Cline, OpenCode, Zed, JetBrains, Gemini CLI,
  Codex, Trae y Kiro.
- **Consciente del workspace.** Escanea tu proyecto a un `.chamba/workspace.md`
  editable y usa ese contexto en los planes.
- **Plan + review heurístico (sin LLM).** Detecta falta de tests, trabajo sin
  responsable, áreas sensibles sin evaluación de riesgo, y más.
- **Paralelismo seguro.** Los git worktrees aíslan el trabajo paralelo; el cleanup
  conserva las ramas para que vos las mergees a mano — nunca `--force`, nunca merge
  automático. Antes del fan-out, chamba reporta overlap de archivos, un preview de
  conflictos con `merge-tree`, y (opt-in) un `PORT` único por worktree para que dos
  servidores de QA no bindéen `:3000`. `worktrees.baseBranch` acepta una sola rama
  **o** un mapa por repo (`{ "web": "main", "api": "develop", "*": "main" }`) para que
  cada repo forkee desde su propia rama de integración.
- **Obsidian + memoria entre sesiones.** Trae contexto de tu vault, escribe resúmenes
  de vuelta, y persiste conocimiento como markdown plano. Las notas se agrupan por
  proyecto (por git remote) y cada carpeta mantiene un `INDEX.md` liviano, así el recall
  escanea un índice barato en vez de leer todas las notas.
- **Red de conocimiento.** Una nota, escrita una sola vez, conectada a todos sus temas
  con tags `tema/…` jerárquicos. chamba deriva hubs por tema, índices y Bases de Obsidian
  desde los metadatos, sin duplicar nada. Vocabulario por workspace, reindex determinista.
  `chamba_vault_navigate` permite navegar el árbol de temas y abrir solo las notas cuyo
  `summary`/`keywords` sean pertinentes, manteniendo el contexto liviano.
  Ver [`packages/mcp/README.md` — Knowledge network](./packages/mcp/README.md#knowledge-network).
- **Seguro por defecto.** Ningún agente de chamba borra ni destruye nada por su cuenta
  — un drop/reset/truncate de DB, borrar archivos o datos, un force-push o borrar una
  rama se detienen y te piden confirmación explícita primero (un hook de Claude Code
  también lo refuerza).
- **Paralelismo consciente de recursos.** Antes de que un `/ticket` multi-repo abra
  workers, chamba dimensiona la concurrencia segura según la RAM/CPU de la máquina (sin
  LLM) — así un ticket grande corre en oleadas en vez de trabar una laptop de 8/16 GB.
  Lo capás con `worktrees.maxParallel`.

## Usá chamba desde tu editor

Cada editor se configura con un solo archivo. Walkthroughs completos en
[`examples/`](./examples/).

**Cursor** — `.cursor/mcp.json` ([guía](./examples/cursor-setup)):

```json
{ "mcpServers": { "chamba": { "command": "npx", "args": ["-y", "@chamba/mcp"] } } }
```

**Claude Code** ([guía](./examples/claude-code-setup)):

```bash
claude mcp add chamba -- npx -y @chamba/mcp
```

**VS Code / Copilot** — `.vscode/mcp.json` ([guía](./examples/vscode-setup)).
Ojo: VS Code usa **`"servers"`**, no `"mcpServers"`:

```json
{ "servers": { "chamba": { "type": "stdio", "command": "npx", "args": ["-y", "@chamba/mcp"] } } }
```

**Windsurf** — `~/.codeium/windsurf/mcp_config.json` ([guía](./examples/windsurf-setup)) ·
**OpenCode** — `opencode.json` ([guía](./examples/opencode-setup)).

**Más editores** — [Gemini CLI](./examples/gemini-cli-setup) · [Codex](./examples/codex-setup) (TOML) ·
[JetBrains](./examples/jetbrains-setup) · [Trae](./examples/trae-setup) ·
[Zed](./examples/zed-setup) (`context_servers`) · [Kiro](./examples/kiro-setup).

Para conectar un vault de Obsidian, agregá `"env": { "CHAMBA_OBSIDIAN_VAULT_PATH": "/ruta/al/vault" }`.
¿No tenés uno? `chamba_workspace_init` crea un vault **global fuera de tus repos**
(`~/.chamba/vault`, autodetectado) y siembra una nota "Workspace overview" cuando no encuentra
ninguno — así la memoria funciona desde el día uno sin ensuciar el repo.

¿Dudás de que todo esté bien conectado? Corré `npx @chamba/mcp doctor` (o la tool `chamba_doctor`
desde tu editor) para un chequeo pass/warn/fail de Node, git, el workspace, la config, el vault,
el directorio de logs y los worktrees.

## Tools

| Tool | Input | Output |
|---|---|---|
| `chamba_workspace_init` | `{ root?, createVault? }` | Escanea y escribe `.chamba/workspace.md` (no sobrescribe); detecta el stack de auth (Auth0/Firebase/Cognito/…) en una sección `## Auth`; crea un **vault global fuera de tus repos** (`~/.chamba/vault`) si no hay ninguno, y gitignorea un vault que viva dentro de un repo |
| `chamba_workspace_show` | `{}` | Contenido de `.chamba/workspace.md` |
| `chamba_workspace_reload` | `{}` | Un diff vs un re-escaneo (sin escribir) |
| `chamba_load_context` | `{ task, includeObsidian?, includeRules? }` | Resumen del workspace + notas relevantes del vault. Si el vault tiene un `INDEX.md` generado por chamba, devuelve un `## Mapa del vault` (nodos de tema relevantes + notas puntuadas por `summary`/`keywords`, ≤ 25 % del presupuesto de tokens) en vez de una lista plana |
| `chamba_load_skills` | `{ task, max? }` | Playbooks del equipo relevantes desde `.chamba/skills/*.md` (index-first, sin LLM) + el catálogo. Vacío por defecto, opt-in |
| `chamba_load_design` | `{ task, max? }` | Resuelve la fuente de diseño enlazada para un ticket (sin LLM): un Figma URL, una carpeta de mockups/specs, o un prototipo standalone `.html`/`.zip` declarado en `.chamba/design/*.md` — devuelve el brief + paths de assets + la preferencia de arquitectura guardada |
| `chamba_design_prefs` | `{ web?, mobile? }` | Lee/guarda la preferencia de arquitectura de UI (Atomic Design, Feature-Sliced, …) para que el planner pregunte una vez y la reuse. Web y móvil por separado. Sin LLM |
| `chamba_summarize_to_vault` | `{ title, content, projectSlug?, type?, summary?, temas?, keywords?, aliases?, workItem?, related? }` | Escribe un resumen a `proyectos/` — agrupado por proyecto (git remote) + un `INDEX.md` por carpeta para recall barato. El frontmatter opcional (`temas`, `summary`, `keywords`, …) ubica la nota en la red de conocimiento |
| `chamba_save_plan` | `{ title, content, projectSlug?, summary?, temas?, keywords?, aliases?, workItem?, related? }` | Guarda un plan en `plans/` — mismo agrupamiento por proyecto + índice, mismo frontmatter opcional de la red de conocimiento |
| `chamba_vault_status` | `{}` | Ruta del vault resuelta + las notas que chamba ve (diagnóstico); con parche, también qué vínculo está activo (workspace o global) |
| `chamba_vault_join` | `{ code, name, email, deviceLabel?, dir?, confirmUpload?, scope? }` | Se une a un vault de grupo de **parche** con un código o link de invitación: crea el vault local (o usa tu propia carpeta con `dir`), guarda credenciales (0600, fuera del vault) y hace el primer sync. Si la carpeta ya tiene archivos, devuelve un resumen y no sube nada hasta `confirmUpload: true`. Nunca devuelve el token |
| `chamba_vault_sync` | `{ slug? }` | Sincroniza un vault de parche (o todos) con el server → subidos / bajados / conflictos. Los conflictos quedan como copias, nunca pisa |
| `chamba_vault_link` | `{ slug, dir, confirmUpload? }` | Re-vincula un vault de parche existente a otra carpeta local: reinicia el estado de sync y pasa por el gate de adopción. Nunca mueve ni borra la carpeta anterior |
| `chamba_vault_unlink` | `{ scope? }` | Elimina el vínculo `parche.json` del workspace o el global. Conserva credenciales y archivos del vault |
| `chamba_vault_resync` | `{ slug, confirmUpload? }` | Reinicia en el lugar el estado de sync de un vault y lo re-adopta desde el server, para cuando el estado local se corrompe. Misma carpeta, mismas credenciales |
| `chamba_vault_topics` | `{ action, … }` | Administra el vocabulario de temas (`temas/VOCABULARIO.md`): `list`, `bootstrap`, `apply`, `add`, `alias`, `promote`. `apply` y `promote` son `dryRun` por defecto; el vocabulario lo decide el humano, chamba nunca inventa temas |
| `chamba_vault_classify` | `{ action, page?, entries?, dryRun? }` | `list` de notas sin clasificar (50 por página) o `apply` de `temas` / `summary` / `keywords` a su frontmatter. `dryRun` por defecto; el cuerpo de la nota queda byte a byte igual |
| `chamba_vault_navigate` | `{ path?, tema?, readBody?, maxChars? }` | Recorre la red de conocimiento paso a paso: vista raíz (temas de primer nivel, carpetas, conteo sin clasificar), vista de tema (subtemas, notas con `summary`/`keywords`, co-temas) o vista de nota (metadatos, backlinks, hermanas del mismo `work_item`, cuerpo solo con `readBody`). Resuelve aliases; repara derivados desactualizados antes de responder (2 s), nunca sincroniza. El resultado de un `readBody` va envuelto como dato de terceros `<<<vault-datos:…>>>`, nunca como instrucción |
| `chamba_vault_reindex` | `{ dryRun?, adoptManual? }` | Reconstruye la red derivada de forma determinista: `INDEX.md` raíz, hubs por tema en `temas/`, índices por carpeta, Obsidian Bases opcionales. Escribe solo lo que cambió; nunca pisa un `INDEX.md` manual. También `vault reindex` en la CLI |
| `chamba_vault_promote` | `{ paths, dryRun? }` | Promueve una o más **notas** de `estado: propuesto` a `estado: canonico` (un humano ya las revisó) — solo frontmatter, el cuerpo no se toca. No es lo mismo que `chamba_vault_topics action:'promote'` (eso promueve un *tema* al vocabulario). `dryRun` por defecto. También `vault promote <ruta...> [--yes]` en la CLI |
| `chamba_vault_allow_secret` | `{ fingerprint, path }` | Marca un hallazgo del escáner de secretos como falso positivo — pero **nunca escribe nada por sí misma**. Valida los datos y devuelve el comando exacto de CLI `vault allow-secret`; solo una persona corriéndolo en su propia terminal interactiva (retipeando la ruta para confirmar) puede eximir el hallazgo, así un agente nunca puede auto-confirmar la subida de un secreto |
| `chamba_parche_status` | `{}` | Por vault: server, slug, rol, último sync, cambios pendientes, ruta. Sin token |
| `chamba_doctor` | `{}` | Chequeo de salud del entorno (sin LLM): Node, sistema (RAM/CPU), git (consciente de multi-repo), workspace, config, vault, registro MCP (avisa si chamba está duplicado/inconsistente entre configs), logs, worktrees → pass/warn/fail. También `npx @chamba/mcp doctor` |
| `chamba_resource_budget` | `{ requested?, perWorkerMemMB? }` | Paralelismo seguro para **esta** máquina (sin LLM): lee RAM/CPU/carga en vivo → cuántos worktrees/workers correr a la vez. Consultalo antes de un fan-out multi-repo |
| `chamba_qa_capabilities` | `{}` | Con qué correr la QA de aceptación (sin LLM): web vs móvil (React Native / Expo), tooling E2E, y los simuladores iOS / emuladores Android realmente disponibles (read-only `xcrun simctl` / `adb` / `emulator` — lista, nunca bootea). El agente qa elige su modo con esto |
| `chamba_triage_ticket` | `{ ticket }` | Chequeo heurístico de completitud de un ticket de soporte/bug (sin LLM): `{ present, missing, questions, enoughToStart, score }` — marca si tiene reproducción, esperado-vs-actual, entorno, alcance, criterios de aceptación, severidad, con las preguntas para pedir de vuelta. Potencia `/triage` |
| `chamba_generate_plan` | `{ task, context? }` | Un template de plan para completar |
| `chamba_review_plan` | `{ plan, task, context? }` | `{ approved, issues, suggestions, riskFlags }` — sin LLM |
| `chamba_create_worktree` | `{ taskSlug, workerId, baseBranch?, workItem? }` | Un git worktree aislado |
| `chamba_list_worktrees` | `{}` | Worktrees con flags dirty/stale/ahead-behind y overlap de archivos |
| `chamba_worktree_status` | `{ repos?, baseBranch? }` | Status completo + overlaps (sin LLM). `ok: false` si `failOnOverlap` y hay colisión |
| `chamba_conflict_preview` | `{ baseBranch?, branches? }` | Dry-run `git merge-tree` vs base + pairwise — **nunca mergea** |
| `chamba_partition` | `{ plan?, items?, fromWorktrees? }` | Waves paralelas para que paths que se pisan no corran juntos (predicho = warning) |
| `chamba_worktree_env` | `{ ticket?, worktreePath? }` | `PORT` único opt-in en `.env.local`; salta puertos ocupados; no-op si `ports.enabled` está off |
| `chamba_cleanup_worktree` | `{ branch }` | Borra el dir, **conserva la rama** |
| `chamba_remember` | `{ key, content, tags? }` | Persiste una memoria en markdown |
| `chamba_recall` | `{ query }` | Busca en las memorias guardadas |
| `chamba_get_agent_config` | `{ role }` | `{ model, effort, reasoning_priority, provider, hint }` por rol — sin LLM |
| `chamba_create_worktrees` | `{ ticket, repos?, workItem? }` | Worktrees multi-repo para un ticket (por config); conserva ramas |
| `chamba_cleanup_worktrees` | `{ ticket, repos? }` | Borra los worktrees del ticket, **conserva todas las ramas** |
| `chamba_classify_task` | `{ task, repos?, planText?, acceptanceCriteria?, knownRepos? }` | Clasifica una tarea en una de 4 rutas (trivial, small, substantial, risky) con heurísticas deterministas — sin LLM. Señales: términos de riesgo (auth, DB, pagos, crypto, PII, prod, secrets), completitud del ticket, repos involucrados, trivialidad. Devuelve `{ route, reasons (≤5, en español), signals, confidence, overridable }`. Potencia `/ticket` y `/orq` |
| `chamba_task_metrics` | `{ action: 'start'\|'event'\|'end', workItem, … }` | Registra métricas de progreso de tareas sin guardar texto del ticket ni secretos. `start` inicia el tracking (abre la fase `context`); `event` registra un hito (`planReview`, `verify`, `escalation`, `override`) o un límite de fase/pausa (`phase_start`, `phase_end`, `human_wait_start`, `human_wait_end` — CHAMBA-024); `end` cierra y agrega una línea a `<wsRoot>/.chamba/metrics/tasks.jsonl` (gitignored). Lock in-process; chamba nunca ve tokens |
| `chamba_task` | `{ action: 'open'\|'update'\|'scope_change'\|'evidence'\|'verify'\|'close'\|'get', workItem, … }` | Mantiene un documento de tarea vivo en el vault (CHAMBA-022) y bloquea `close` sin evidencia real. `open` lo crea (idempotente, se omite en ruta `trivial`); `update` edita progreso/checklist/estado de AC (nunca el texto del AC); `scope_change` es la única vía para agregar/reabrir/descartar un criterio; `evidence` copia salida de QA dentro de un presupuesto; `verify` corre los comandos configurados del repo vía `ProcessPort.run` (nunca un string de shell) y registra exit codes + salida redactada; `close` rechaza cerrar sin evidencia real (o un `partial` explícito, aprobado por el usuario); `get` devuelve el documento + siguiente paso + estado de la compuerta para `/ticket resume` |
| `chamba_create_worktree` / `chamba_create_worktrees` | `{ …, workItem? }` | `workItem` opcional (CHAMBA-024): atribuye el tiempo de git del propio tool a `phases.setup.toolMs` de esa tarea en `chamba_task_metrics`. Best-effort — nunca cambia el resultado del tool ni lo hace fallar. |

## Cómo funciona

chamba aporta tools y patrones; el modelo de tu editor aporta el razonamiento.

```
Vos (en Cursor):  "@chamba orquesta: agrega un endpoint de health check"
        │
        ▼
El modelo del editor razona y llama a las tools de chamba:
        │
        ├─▶ chamba_load_context   →  mapa del workspace + notas relevantes
        ├─▶ chamba_generate_plan  →  esqueleto de plan que el modelo completa
        ├─▶ chamba_review_plan    →  veredicto heurístico (sin LLM); el modelo corrige
        ├─▶ chamba_create_worktree→  rama aislada por worker (si hay git)
        │       … el modelo escribe código y tests en el worktree …
        └─▶ chamba_summarize_to_vault → nota estructurada de vuelta a Obsidian
        │
        ▼
Resultado en el chat de tu editor. Las ramas quedan abiertas para que las revises.
```

## Rutas proporcionales

`/ticket` y `/orq` eligen el flujo adecuado de forma heurística — sin LLM — mediante
`chamba_classify_task`. La ruta se anuncia en una línea y se puede cambiar con `--route`.

| Ruta | Plan | Revisión del plan | Verificación | Cuándo |
|---|---|---|---|---|
| **trivial** | 3 líneas inline | no | lint + tests existentes | typo, copy, color, bump patch, renombre |
| **small** | plan breve por implementer (≤ 10 líneas) | no | tests + 1 pasada de reviewer | cambio acotado, 1 repo, sin señales de riesgo |
| **substantial** | planner | máx. 2 rondas | re-verificación máx. 2 rondas | multi-repo, alcance difuso, palabras de alcance (refactor, migrar, rediseño, reescribir, nuevo módulo), un bump major de dependencia o un upgrade no-patch de framework/runtime (react, nestjs, expo, typescript, node…), o cualquier señal de riesgo débil (admin, acceso, rol, índice…) |
| **risky** | planner + `needs-approval` | máx. 2 rondas | reviewer enfocado en riesgo + guardia DB (CHAMBA-013) | riesgo fuerte (migración DB, duración de token/sesión, pagos: checkout, precio, descuento, reembolso, factura…, crypto, prod, secretos) o ≥ 2 términos de auth/pagos |

**Ejemplos del clasificador (tomados de los tests):**

| Tarea | Ruta |
|---|---|
| `Corregir typo en el botón de enviar` | trivial |
| `Add a new GET /users/:id/profile endpoint` | small |
| `Sync user model across api, worker, admin repos` | substantial |
| `Cambiar el flujo de autenticación JWT para soportar refresh tokens` | risky |
| `Run database migration to add new columns to users table` | risky |
| `Integrar Stripe para cobros recurrentes` | risky |
| `Update .env variables for the production database connection` | risky |

**Métricas de tareas** (`chamba_task_metrics`) registran resultados por ticket en
`<wsRoot>/.chamba/metrics/tasks.jsonl` — gitignored automáticamente si el workspace
está dentro de un repo git. Campos: `workItem`, `startedAt`, `endedAt`, `routeSuggested`,
`routeFinal`, `overridden`, `escalations`, `planReviewRounds`, `verifyRounds`,
`notesRead`, `testsPassed`, `qaResult`, `delivered`, `source`. **Sin texto del ticket,
sin rutas de archivos, sin secretos.** chamba nunca ve tokens (protocolo MCP). El estado
en vuelo vive en `<wsRoot>/.chamba/metrics/inflight/<workItem>.json` (escritura atómica,
limpieza cada 7 días); el lock es in-process (el acceso cross-process es una limitación conocida).

**Fases y atención humana (CHAMBA-024).** Dos campos opcionales viajan en la misma
línea, ambos ausentes en líneas escritas antes de 1.16.0 (el CLI las reporta como
"sin desglose"):

- `phases: { <fase>: { ms, count, inferred?, toolMs?, toolCount?, humanWaitMs? } }` —
  10 fases: `context`, `setup`, `plan`, `plan_review`, `implement`, `test`, `review`,
  `qa`, `verify`, `close`. Solo `ms`/`count` entran en el
  % del share; `toolMs` (tiempo de git que `chamba_create_worktree(s)` mide por sí
  mismo) es informativo y nunca cuenta en el share. **`phase: 'verify'` es un eje
  distinto de `kind: 'verify'`** (el contador de rondas de revisión de CHAMBA-020) —
  coexisten.
- `humanWaits: { count, ms, byReason }` — 6 motivos: `clarification`, `risky_confirm`,
  `needs_approval`, `qa_interactive`, `final_review` (se cuenta — `byReason.final_review.count`
  sube en cada ticket, incluso inferido — pero su duración siempre es `n/d`: las
  muestras solo vienen de pausas no inferidas, y `final_review` siempre se cierra
  `inferred` justo antes de `end`), `other`.
- **Alcance de la fase `test`:** en `substantial`/`risky`, la fase `test` de `/ticket`
  suma la corrida del tester (paso 6) **y** la corrida completa de la suite (paso 7)
  — comparten la misma fase, sumada por ronda. En `trivial`/`small`, solo cuenta la
  corrida de la suite (no hay paso de tester separado).

```bash
npx @chamba/mcp metrics                         # tabla por ruta, separada por source (ticket / orq) + total
npx @chamba/mcp metrics --since 30d             # filtra los últimos 30 días (también: 24h, 2w)
npx @chamba/mcp metrics --phases --route small --since 30d  # medianas/p90/% por fase + pausas al humano
```

`--phases` calcula el `%` de cada fase **sobre el reloj de pared** del ticket
(`endedAt - startedAt`), no sobre la suma de fases — la diferencia se reporta en su
propia fila `unaccounted` ("sin fase / traspasos": tiempo que ninguna fase reclamó,
p. ej. traspasos entre subagentes). Las fases + `unaccounted` siempre suman
exactamente 100 %; si `unaccounted` es la mayor, el render lo dice explícitamente.
La tabla por defecto (sin `--phases`) queda idéntica, byte a byte, a la de 1.15.1.

## Tareas vivas y evidencia

`/ticket` y `/orq` mantienen un documento vivo por ticket — `tareas/<work_item>.md` en
el vault — vía `chamba_task`. Es la fuente de verdad del estado del ticket; a
diferencia de `chamba_task_metrics`, que solo registra hechos de cómo corrió el
ticket, este documento guarda qué es el ticket: sus criterios de aceptación, el
progreso, los cambios de alcance y las corridas de verificación. Los tickets
`trivial` nunca tienen uno — siguen con un resumen de 3 líneas. El texto de un
criterio de aceptación es inmutable una vez escrito: la única vía para descartar uno
es `scope_change(change='discard')`, que exige `reason` **y**
`requestedByUser: true` — el prompt del agente te pide esa aprobación primero. La
inmutabilidad se hace cumplir, no solo se documenta: cada escritura estampa un digest
(`chamba_digest` en el frontmatter) sobre los bloques de criterios/evidencia/cambios de
alcance, y cada lectura lo recalcula y compara — una edición a mano de alguno de esos
tres bloques entre escrituras hace que `update`/`scope_change`/`verify`/`close`
rechacen actuar sobre el documento hasta que se resuelva (`get` solo reporta la
violación, porque no escribe).

**`verify` corre comandos reales, no una afirmación.** `chamba_task(action='verify')`
ejecuta los comandos configurados para cada repo tocado y escribe su salida como
evidencia — chamba de verdad los corrió, el agente no se limitó a decir "pasaron los
tests". Una vez que el documento queda atado a un worktree (lo fija el primer
`open`/`verify` con `worktreePath`), todo `verify` posterior de ese ticket tiene que
apuntar al MISMO worktree — apuntar a otro distinto se rechaza, así la evidencia nunca
queda recolectada contra el checkout equivocado. Configuralos en `repos.<nombre>.verify`, en **cualquiera** de dos capas:
`~/.chamba/config.json` (global) o `<raíz-del-workspace>/.chamba/config.json`
(proyecto) — **nunca** un archivo dentro de un worktree o de un repo clonado: un
repo hostil o un PR malicioso no puede inyectar un comando por esta vía.

```json
{
  "version": 1,
  "repos": {
    "chamba": {
      "verify": [
        { "name": "unit", "command": "pnpm", "args": ["test"], "timeoutSec": 600 }
      ]
    }
  }
}
```

`command` es el ejecutable desnudo — sin espacios, sin metacaracteres de shell — y
`args` es un array plano; chamba nunca parsea un string a argv (ahí nacen las
inyecciones) y nunca corre nada a través de un shell. **Nota Windows:**
`pnpm`/`npm`/etc. son archivos `.cmd`; chamba los corre vía `cmd.exe /d /s /c` con
una allowlist de caracteres seguros en cada arg (sigue sin ser un string de shell).
Si preferís no depender de eso, la forma portable funciona en cualquier OS:
`{ "command": "node", "args": ["<ruta-al-cli>.js", "test"] }`. Opcional por
comando: `cwd` (relativo, contenido dentro del worktree), `timeoutSec` (default 600,
máx 1800 — se mata el proceso y todo su árbol al vencer), `env` (vars extra sobre
la allowlist de abajo) e `inheritEnv: true` (opt-in al entorno completo del padre).
Por default el proceso hijo recibe una **allowlist**, no tu entorno completo —
`PATH`, `HOME`/`USERPROFILE`, `SystemRoot`/`windir`, `TEMP`/`TMP`/`TMPDIR`, `ComSpec`,
`PATHEXT`, `LANG`/`LC_ALL`, `TZ`, `CI`, y todo lo que empiece con `NODE_` o
`npm_config_` — porque el server MCP hereda el entorno de tu editor, que puede traer
tokens, y esa salida se escribe en un vault que comparte tu equipo.

**Dos niveles de evidencia.** Un repo con `verify` configurado tiene evidencia
*medida* — chamba corrió el comando, capturó exit code/duración/las últimas 200
líneas (redactadas por secretos) y el `head`/estado sucio de git contra el que
corrió. Un repo sin uno igual cierra, pero su evidencia queda marcada como
**reportada por el agente** — más débil, y así se dice explícitamente en el bloque
de cierre. Los tickets `risky` son la excepción: cerrar sin `verify` configurado
para un repo tocado queda bloqueado (configuralo, o cerrá `partial`).

**La compuerta de cierre.** `chamba_task(action='close')` rechaza cerrar si: (1) un
AC pendiente sin razón, (2) un AC "pasa" cuya evidencia **no resuelve a nada que
chamba haya registrado** (un string cualquiera no cuenta), (3) una corrida de verify
fallida o con timeout, (4) un ticket `risky` donde ni siquiera se puede determinar el
repo tocado, o el repo tocado no tiene `verify` configurado, (5) un AC en
`falla`, o (6) un AC descartado sin la entrada correspondiente en el log de cambios
de alcance. Si rechaza, **no lo rodees** — resolvé lo que falta, o pedí
`partial: true` + `approvedByUser: true`: esto cierra como entrega parcial y solo se
alcanza con tu aprobación explícita (chamba nunca se la auto-otorga). Queda
registrado en el documento con la fecha y la frase "cierre parcial aprobado por el
usuario" — la regla 6 es la única excepción que `partial` nunca exime, porque un AC
descartado sin procedencia registrada es un problema de integridad del registro, no
trabajo pendiente.

**`/ticket resume <work_item>` / `/orq resume`.** `chamba_task(action='get')`
devuelve el documento, el siguiente paso calculado, el resultado de la compuerta y
el `worktreePath` del último `open`/`verify`; el agente lo reconcilia contra
`git status --porcelain` + `git diff --stat` sobre el worktree real y continúa
desde ahí en vez de reiniciar el ticket.

**La evidencia de QA** se copia a `tareas/<id>/evidencia/<run>/qa/` con límites —
2 MB por imagen, 20 MB por run, 200 archivos — más allá de los cuales un archivo se
enlaza en vez de copiarse (nunca se descarta). El texto de evidencia (`report.md`,
`tests-*.md`) siempre sincroniza a tu vault de parche; las **imágenes** de
evidencia solo sincronizan con `vault.syncEvidence: true` (default `false`), en las
mismas dos capas de config que `repos.*.verify`:

```json
{ "version": 1, "vault": { "syncEvidence": true } }
```

La primera sincronización que incluye una imagen de evidencia bajo esa opción avisa
una vez que las capturas **no se escanean por secretos** y pueden contener datos
sensibles — es una decisión explícita, no un default silencioso.

**Limitaciones conocidas** (documentadas, no resueltas aquí): el lock del documento
de tarea es solo in-process, y el reindex del vault no está serializado entre tools
dentro del mismo proceso — dos servers, o `open`/`close` corriendo a la vez que
`chamba_summarize_to_vault`, pueden pisarse los derivados. Hay una ventana TOCTOU
entre el chequeo de containment por realpath y la copia real de evidencia de QA
(la misma clase de brecha ya documentada para el escaneo de secretos). Y la
evidencia no tiene retención ni rotación — el subárbol `tareas/**/evidencia/` solo
crece; limpiarlo sería destructivo, así que queda en tus manos. `verify` retiene el
lock de la tarea durante toda la corrida (hasta `timeoutSec`, 30 minutos máximo) —
otras acciones de `chamba_task` para el **mismo** `workItem` quedan en cola; otros
tickets no se ven afectados. Y un `verify` en curso cuando se mata el proceso del
server MCP (no un SIGINT/SIGTERM prolijo, que solo cierra el transporte) puede dejar
su árbol de procesos corriendo — chamba hoy no rastrea ni mata árboles de `verify` en
vuelo al apagar el server.

## Extras por editor (opcional)

Todo editor MCP tiene las tools. En **Claude Code**, **Cursor** y **OpenCode** podés además
instalar los slash commands y subagentes (mismos prompts, una sola fuente):

```bash
npx @chamba/cursor-extras@latest install     # Cursor:   /ticket, /triage, /qa, /parche … + subagentes + MCP
npx @chamba/opencode-extras@latest install   # OpenCode: /ticket, /triage, /qa, /parche … + subagentes + MCP
```

En **Claude Code** además tenés hooks:

```bash
npx @chamba/claude-extras@latest install     # /ticket, /triage, /workspace, /map, /qa, /design, /parche … +
                                      # agentes planner/implementer/reviewer/tester/qa/diagnostician + 2 hooks
npx @chamba/claude-extras uninstall
```

Idempotente, no sobrescribe tus archivos (`--force` para forzar), preserva otros MCP
servers en `~/.claude.json`. `--force` y `uninstall` hacen snapshot del estado actual antes,
así `npx @chamba/claude-extras rollback` los deshace. Agregá `--global` para instalar
`@chamba/mcp` global y lanzar el binario `chamba-mcp` en vez de `npx` — una conexión más
estable que no se cae por un spawn con suerte. Después: `/orq agrega un endpoint de health check`.

**Config por agente.** El primer install corre un wizard para elegir modelo + esfuerzo
por rol (orchestrator, planner, reviewer, implementer, tester, qa, summarizer, researcher),
con defaults eficientes pre-configurados y tuneados para ahorrar tokens: **Opus 5** para los
roles de razonamiento (calidad de Fable 5 a mitad del precio de API, mismo precio que Opus 4.8)
y **Sonnet 5** para ejecución (intro $2/$10 hasta ago-2026). **Fable 5** queda opt-in — y viene
incluido en el plan Claude Max (hasta 50% del límite semanal, Claude Code ≥ 2.1.170). Reconfigurás
con `npx @chamba/claude-extras config <show|set|wizard|…>`, o cambiás todo el dial de
costo/calidad de una con `config preset <budget|balanced|quality|fast>`.
chamba sigue sin llamar a ningún modelo: esto solo le dice al modelo de tu editor cómo
delegar. Otros editores leen la misma config vía `chamba_get_agent_config`. Ver el
[README de claude-extras](./packages/claude-extras/README.md#configuration-per-agent-model--effort).

**Triage read-only antes de comprometerte a un fix.** `/triage BUG-42` es la mitad
delantera de `/ticket` con la trasera apagada: investiga y propone un fix pero **nunca
toca código** — sin worktrees, ediciones ni commits. Corre un chequeo heurístico de
completitud sin LLM (`chamba_triage_ticket`) que marca qué le falta al ticket —
reproducción, esperado-vs-actual, entorno, alcance, criterios de aceptación, severidad —
con las preguntas exactas para pedir de vuelta, y después el agente `diagnostician`
investiga y devuelve una hipótesis de causa raíz (con evidencia `archivo:línea`), el blast
radius, una reproducción y un **plan de fix propuesto** en un bloque listo para pegar en el
ticket. Cuando estás listo, le pasa el plan guardado a `/ticket -p` para ejecutarlo. Ideal
para casos de soporte y pre-diagnóstico.

**QA de aceptación, como co-piloto.** Cuando un ticket es user-facing, el agente `qa`
valida los criterios de aceptación contra la app *corriendo* — maneja un navegador real
si el repo tiene Playwright/Cypress (o un MCP de browser), si no levanta la app desde el
worktree y co-pilotea con vos. Para apps **React Native / Expo** corre en un **simulador o
emulador** (vía el MCP de Expo/móvil de tu editor, o `expo start` co-piloteado, o Expo Go
en tu teléfono) — `chamba_qa_capabilities` reporta qué tiene esta máquina. Cada login es tu
paso; reusa los usuarios/roles que ya existen en vez de crear cuentas descartables, siembra
solo de forma aditiva, y captura una screenshot numerada por criterio (PASS y FAIL) en una
carpeta de evidencia por corrida, fuera de todo repo git. Corrélo dentro de `/ticket` o
suelto con `/qa`.

**Design-aware para tickets visuales.** Enlazá tu diseño una vez — `/design link checkout
~/Designs/checkout` escribe un pointer `.chamba/design/*.md` a una carpeta **externa** de
mockups, un Figma URL, o el prototipo standalone `.html`/`.zip` que te da tu herramienta de
diseño (fuera del repo). Después `chamba_load_design` lo resuelve por ticket: el planner lo
captura en un `## Design`, el implementer construye contra los tokens de **Figma** (si hay MCP)
o los mockups/prototipo, y el qa hace un **check visual** contra la misma referencia. En el
primer ticket visual, el planner **te pregunta la arquitectura** (Atomic Design, Feature-Sliced,
…) y la **guarda** (`chamba_design_prefs`, web y móvil por separado) — la reusa en silencio
después. chamba nunca llama a Figma ni corre el prototipo — lo hace el MCP / browser de tu
editor — y es honesto: *design-accurate*, no "pixel perfect".

## chamba en varias máquinas

chamba no tiene servidor — lo que dos máquinas comparten es el **vault** (contexto, memoria,
planes). Sincronizás la carpeta del vault (Syncthing para tiempo real; iCloud o un repo git
privado también sirven) y apuntás el `CHAMBA_OBSIDIAN_VAULT_PATH` de cada máquina ahí —
global (`~/.chamba/vault`) o por-proyecto (el env en un `.mcp.json` / `.cursor/mcp.json` del
proyecto, o un `.obsidian/` en la raíz, que chamba detecta probando el `cwd` primero). Después
corrés chamba en paralelo entre máquinas: sin techo de RAM de una sola, menos espera. **Guía:
[examples/multi-machine-vault](./examples/multi-machine-vault).**

## Seguridad del vault compartido

Un vault compartido (parche) lo escribe el agente de cada persona del equipo, así que chamba
lo trata como un lugar que necesita **gobernanza**, no solo almacenamiento.

**Escaneo de secretos (determinista, sin LLM).** Todo archivo `.md`/`.canvas`/`.base`/`.svg` con un
cambio local se escanea antes de salir de la máquina — en `vault sync` y al adoptar por
primera vez una carpeta existente (`vault join` / `vault link`). El escáner busca **formas**
de valor (prefijos de tokens de proveedores, JWTs, headers PEM de llave privada, connection
strings de base de datos con credenciales embebidas, y una asignación genérica `clave: valor`
de alta entropía) — nunca nombres de proveedores específicos ni valores de ejemplo, por eso
este README lista *tipos*, no patrones para copiar. Un archivo con un hallazgo queda
**excluido de esa subida** (el resto del lote sigue); nada se borra ni se reescribe en disco,
y el mismo gate aplica a las copias de conflicto, así un secreto no se escapa por la puerta de
atrás de un conflicto de sync. `vault status` y cada resumen de `vault sync` siguen listando
un archivo bloqueado hasta que se resuelva.

**Resolver un bloqueo.** Quitá el valor del archivo (o reemplazalo por `<REDACTADO>`), o —
si el hallazgo es un falso positivo — corré `vault allow-secret <fingerprint> --path <ruta>`
**vos mismo, en tu propia terminal interactiva**: muestra la ruta/línea/tipo (nunca el valor)
y te pide retipear la ruta para confirmar. Esta allowlist local vive en `.chamba-sync/` y
**nunca se sincroniza** a tus compañeros — cada máquina confirma sus propios falsos
positivos. `chamba_vault_allow_secret` (la tool MCP) nunca escribe la allowlist por sí misma;
solo devuelve el comando exacto de CLI, así una nota que intente inyectar instrucciones a un
agente para que exima un secreto no puede lograrlo.

**El servidor también escanea — y puede rechazar lo que suba.** `vault sync` envía, junto
con cada archivo, los fingerprints que tu propia allowlist ya exoneró para ese contenido
(nunca la allowlist completa, nunca un valor) para que el servidor (`parche`) no vuelva a
bloquear lo que ya revisaste. Si el servidor igual rechaza un blob (`422`), ese archivo queda
excluido de esa subida — el resto del sync sigue y termina sin error — y `vault status`
lo lista como **"rechazado por el servidor"**. A diferencia de un bloqueo local, este NO
ofrece `allow-secret`: el servidor no devuelve el fingerprint del hallazgo, así que no hay
nada que eximir todavía. El mensaje sugiere actualizar chamba (`npx -y @chamba/mcp@latest`
— el servidor puede tener reglas más nuevas que tu versión) o directamente quitar el valor
del archivo; en cuanto el contenido cambia (o el archivo se borra), el siguiente sync lo
reintenta automáticamente.

**El falso positivo de `token = crypto.randomUUID()` está corregido.** La regla de
asignaciones (`clave: valor` / `clave = valor`) ya no marca una llamada de función
(`token = crypto.randomUUID()`), un acceso a miembro (`crypto.randomUUID`) o una ruta de
archivo (`docs/api-keys.md`) como posible secreto cuando el valor va **sin comillas** — son
formas de código, no secretos. Un valor **entre comillas** (`token = "crypto.randomUUID()"`)
sigue marcando igual que siempre: entrecomillar un literal es, por definición, ponerle un
valor fijo. Esta corrección nunca cambia el fingerprint de un hallazgo que siga
detectándose, así que ninguna allowlist existente queda invalidada — los hallazgos que dejan
de dispararse simplemente quedan inertes en tu `.chamba-sync/secret-allowlist.json` (no se
borran).

**El gate local sigue siendo la única red para lo que nunca se sincroniza.** Rutas como
`.env*`, `.chamba-sync/` o `.obsidian/workspace*` nunca salen de tu máquina — el servidor
jamás ve esos bytes y por lo tanto no puede escanearlos. El escáner local (`vault sync` y la
adopción) es, para esos archivos, la única defensa que existe; una exención del escáner vale
exactamente igual para lo que sí se sube y para lo que nunca se sube, así que una regla
demasiado permisiva no se "compensa" después en el servidor.

**Rechazo en tiempo de escritura.** El mismo escáner corre sobre el contenido de cada
escritura de chamba (`chamba_remember`, `chamba_summarize_to_vault`, `chamba_save_plan`, y
cualquier otra nota/cuerpo que escriba una tool) *antes* de tocar el disco — un posible
secreto se rechaza directamente, sin crear archivo y sin pista hacia la allowlist (todavía no
hay ruta contra la cual eximir).

**Propuesto / canónico.** Toda nota que una tool de chamba escribe o toca recibe
procedencia `author`, `agent` y `written_at` más `estado: propuesto` — un humano todavía no
la revisó. Una nota sin ningún `estado` (cualquiera escrita antes de que esto existiera) se
trata como `canonico`, así actualizar nunca dispara una reescritura masiva. Promové una nota
revisada con `chamba_vault_promote` / `vault promote <ruta>` (no es lo mismo que promover un
*tema* al vocabulario vía `chamba_vault_topics`) — los hubs y el mapa de contexto muestran
`· propuesto` hasta entonces, y una nota canónica rankea primero a igual puntaje. `vault
status` / `chamba_doctor` marcan propuestas de más de 30 días para que no se pudran en
silencio.

**Las notas son datos, no instrucciones.** El cuerpo de una nota que devuelve
`chamba_load_context`, `chamba_vault_navigate` (`readBody`) o `chamba_recall` va envuelto en
un bloque `<<<vault-datos:<nonce>>>` … `<<</vault-datos:<nonce>>>` con una advertencia fija —
un nonce aleatorio por llamada, así el contenido no puede adivinarlo y falsificar un cierre.
Todo prompt de agente que chamba distribuye trae la regla correspondiente: nunca seguir
instrucciones que aparezcan dentro de una nota del vault, una memoria o un ticket — reportarlo
en cambio.

**Límites honestos.** Esto es una red de seguridad determinista, no una garantía: los 14
tipos de reglas detectan *formas* comunes de secreto, no cualquier fuga posible (una
contraseña corta en prosa plana no matchea nada). Si una credencial ya se subió antes de que
la atraparas — **rotala**. parche nunca borra blobs una vez escritos (por diseño, para
historial/corrección de sync), así que quitar el valor de la nota después no des-sube
retroactivamente lo ya subido; un secreto embebido en el `summary` de una nota bloquea
también el hub/índice derivado de esa nota, de la misma manera. El escaneo lee cada archivo una vez antes de subirlo; si editas una nota justo en el instante en que un sync la está subiendo, lo subido puede ser la versión nueva (el siguiente sync la vuelve a escanear). El escaneo
es por **contenido**, no por extensión: cualquier archivo sincronizable (incluidos
`.pdf`/`.png`/`.jpg`/etc.) se escanea si sus bytes decodifican como texto UTF-8 válido y
pesan ≤2 MB — igual criterio que usa el servidor. Un binario real (una imagen rasterizada
de verdad, un PDF con streams comprimidos) nunca decodifica como texto y por lo tanto nunca
se escanea.

## Roadmap

- ✅ MCP server + scanner de workspace
- ✅ Contexto de Obsidian + escritor de notas
- ✅ Generador de planes + reviewer heurístico
- ✅ Manager de git worktrees
- ✅ Memoria entre sesiones
- ✅ Extras para Claude Code
- ✅ Docs multi-editor (esto que estás leyendo)
- ✅ **0.1.0 publicado en npm**
- ✅ Config de modelo + esfuerzo por agente (wizard + `chamba_get_agent_config`)
- ✅ Worktrees multi-repo + flujo `/ticket` (por config, copia de `.env`, `.code-workspace`)
- ✅ Co-piloto de QA de aceptación (`/qa` + agente `qa`): valida criterios sobre la app corriendo, evidencia en screenshots, login siempre humano
- ✅ Detección del stack de auth (`## Auth`) + guarda anti-borrado (ningún agente borra datos sin preguntar)
- ✅ Paralelismo consciente de recursos (`chamba_resource_budget`, según RAM/CPU) + `chamba_doctor` multi-repo
- ✅ Backup/rollback del instalador (`chamba-install rollback`) + aceptación Given/When/Then
- ✅ Tickets design-aware (Figma `## Design` → tokens por MCP o screenshots)
- ✅ Registro de skills/playbooks (`chamba_load_skills`, index-first, opt-in)
- ✅ QA móvil para React Native / Expo (`chamba_qa_capabilities` → simuladores/emuladores)
- ✅ Más editores: Zed, JetBrains, Gemini CLI, Codex, Trae, Kiro (guías de setup + detección de reglas)
- ✅ Fuentes de diseño enlazables (`chamba_load_design`) + preferencia de arquitectura (`chamba_design_prefs`, `/design`)
- ✅ Calidad de release: golden tests del reviewer, `doctor` como gate en CI, instalación `--yes`, `RELEASING.md`
- ✅ Vault repo-safe: bootstrap fuera de repos (`~/.chamba/vault`), backstop gitignore, warning del doctor
- ✅ **0.20.0 publicado en npm**
- ✅ `/triage` read-only: pre-diagnóstico + plan de fix sin ejecutar (`chamba_triage_ticket` chequeo de completitud, agente `diagnostician`)
- ✅ **0.21.0 publicado en npm**
- ✅ **1.0.0 — primer estable:** versión real en el handshake MCP, superficie de 24 tools + docs pulidas, primer tag estable
- ✅ **1.1.0 — Opus 5 + Sonnet 5:** nuevo reparto de defaults (Opus 5 para razonar a ½ del precio de Fable, Sonnet 5 para ejecutar), tuning de ahorro de tokens, caveat de Fable-en-Max
- ✅ **1.2.0 — conexión confiable:** `install --global` (lanza el binario `chamba-mcp`, sin npx en cada arranque) + check de registro MCP en `doctor` (avisa de duplicados/inconsistencias)
- ✅ **1.3.0 — extras de OpenCode:** `@chamba/opencode-extras` instala los mismos slash commands + subagentes en OpenCode (traducidos a su formato) y registra el MCP
- ✅ **1.4.0 — extras de Cursor:** `@chamba/cursor-extras` instala los mismos comandos + subagentes en Cursor (`.cursor/commands` + `.cursor/agents`, modelo de tu reparto) y registra el MCP
- ✅ **1.5.0 — Paralelismo seguro 2.0:** status de worktrees + overlap, preview `merge-tree` (nunca mergea), waves, PORT opt-in
- ✅ **1.6.0 — Rama base por repo:** `worktrees.baseBranch` acepta un mapa por repo para que cada repo forkee de su propia rama de integración (ej. `web`=main, `api`=develop)
- ✅ **1.7.0 — Protocolo de sync de vault:** `@chamba/core` trae el protocolo v1 de parche (sync privado de un vault Obsidian entre miembros de un grupo): schemas, roles, copias en conflicto y un planificador puro de push/pull. Solo la base, sin tools nuevas
- ✅ **1.8.0 — Vaults de grupo (cliente de parche):** CLI `vault join/sync/status/leave` + `chamba_vault_join` / `chamba_vault_sync` / `chamba_parche_status`; las tools de contexto y memoria sincronizan solas en segundo plano (tope de 10 s). Memorias del grupo en el vault, las personales nunca se suben. Detalle en el [README de `@chamba/mcp`](./packages/mcp/README.md#parche--group-vaults)
- ✅ **1.9.0 — Tu propia carpeta de vault:** `vault join --dir` / `vault link <slug> --dir` usan cualquier carpeta como vault de parche; un gate de adopción segura muestra qué se subiría y espera `--yes` (o `confirmUpload`) antes de sincronizar archivos existentes
- ✅ **1.10.0 — parche por workspace + `/parche`:** cada workspace vincula su propio vault de grupo en `.chamba/parche.json` (sin código ni token), por encima de `CHAMBA_OBSIDIAN_VAULT_PATH` y del vínculo global; comando `/parche` en todos los editores + `chamba_vault_link` / `chamba_vault_unlink` / `chamba_vault_resync`; `autoSync` por vínculo. Los cuatro agentes base ahora consideran N+1, concurrencia sin límite, timeouts e idempotencia por defecto (skills de ejemplo en `examples/skills/`)
- ✅ **1.11.0 — parche en redes reales + Windows:** el sync sube solo los blobs que le faltan al server por una sola conexión keep-alive (100 archivos nuevos: de 102 conexiones TCP a 1), reintenta errores transitorios con backoff y dice qué falló en vez de `fetch failed`; el cliente de parche funciona en Windows (rutas con unidad y UNC, ACL solo-usuario en las credenciales); CI en ubuntu, windows y macOS
- ✅ **1.12.0 — Red de conocimiento en el vault:** temas jerárquicos `tema/…` desde un vocabulario que controla el humano; una nota puede estar en varios temas sin duplicarse. `chamba_vault_topics`, `chamba_vault_classify` y `chamba_vault_reindex` arman hubs por tema, índices y Obsidian Bases opcionales de forma determinista (mismos bytes en cualquier máquina), y parche los sincroniza sin copias en conflicto
- ✅ **1.13.0 — Navegar la red de conocimiento:** `chamba_vault_navigate` recorre temas → subtemas → notas (con backlinks y hermanas del mismo `work_item`) y `chamba_load_context` devuelve un mapa del vault en vez de una lista plana, así los agentes navegan antes de leer
- ✅ **1.14.0 — Rutas proporcionales (ODD paso 1):** `chamba_classify_task` elige el flujo adecuado heurísticamente — sin LLM — (trivial → small → substantial → risky); `/ticket` y `/orq` siguen la ruta; `chamba_task_metrics` registra resultados por ticket en un `.jsonl` local (gitignored); `npx @chamba/mcp metrics` muestra una tabla por ruta y source
- ✅ **1.15.0 — Seguridad del vault compartido:** un escáner de secretos determinista (14 reglas: API keys, tokens de nube y de forjas, JWT, llaves PEM, connection strings con credenciales, asignaciones de alta entropía) bloquea cualquier nota con un posible secreto antes de que salga de la máquina; toda escritura de chamba lleva procedencia y `estado: propuesto | canonico` (`chamba_vault_promote` marca una nota como revisada); el cuerpo de las notas vuelve envuelto como datos para que no pueda inyectar instrucciones
- ✅ **1.16.0 — Tiempo por fase:** `/ticket` y `/orq` registran cuánto dura cada fase (contexto, setup, plan, review, implementación, tests, QA, cierre) y cuánto esperan al humano, por motivo; `npx @chamba/mcp metrics --phases` muestra mediana, p90 y porcentaje por ruta, más el tiempo sin fase, para ver dónde se va realmente el tiempo de un ticket
- 🔭 V2: búsqueda semántica del vault, MCP sampling, más bases de conocimiento

Ver [`PLAN.md`](./PLAN.md) para el plan completo de fases.

## Requisitos

- Node 22 LTS
- pnpm 9+ (para desarrollo)
- Un editor con cliente MCP (para usar las tools)

## Licencia

MIT — ver [`LICENSE`](./LICENSE). Hecho con cariño en Colombia.
