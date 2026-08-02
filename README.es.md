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
  automático.
- **Obsidian + memoria entre sesiones.** Trae contexto de tu vault, escribe resúmenes
  de vuelta, y persiste conocimiento como markdown plano. Las notas se agrupan por
  proyecto (por git remote) y cada carpeta mantiene un `INDEX.md` liviano, así el recall
  escanea un índice barato en vez de leer todas las notas.
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
| `chamba_load_context` | `{ task, includeObsidian? }` | Resumen del workspace + notas relevantes del vault |
| `chamba_load_skills` | `{ task, max? }` | Playbooks del equipo relevantes desde `.chamba/skills/*.md` (index-first, sin LLM) + el catálogo. Vacío por defecto, opt-in |
| `chamba_load_design` | `{ task, max? }` | Resuelve la fuente de diseño enlazada para un ticket (sin LLM): un Figma URL, una carpeta de mockups/specs, o un prototipo standalone `.html`/`.zip` declarado en `.chamba/design/*.md` — devuelve el brief + paths de assets + la preferencia de arquitectura guardada |
| `chamba_design_prefs` | `{ web?, mobile? }` | Lee/guarda la preferencia de arquitectura de UI (Atomic Design, Feature-Sliced, …) para que el planner pregunte una vez y la reuse. Web y móvil por separado. Sin LLM |
| `chamba_summarize_to_vault` | `{ title, content, projectSlug? }` | Escribe un resumen a `proyectos/` — agrupado por proyecto (git remote) + un `INDEX.md` por carpeta para recall barato |
| `chamba_save_plan` | `{ title, content, projectSlug? }` | Guarda un plan en `plans/` — mismo agrupamiento por proyecto + índice |
| `chamba_vault_status` | `{}` | Ruta del vault resuelta + las notas que chamba ve (diagnóstico) |
| `chamba_doctor` | `{}` | Chequeo de salud del entorno (sin LLM): Node, sistema (RAM/CPU), git (consciente de multi-repo), workspace, config, vault, registro MCP (avisa si chamba está duplicado/inconsistente entre configs), logs, worktrees → pass/warn/fail. También `npx @chamba/mcp doctor` |
| `chamba_resource_budget` | `{ requested?, perWorkerMemMB? }` | Paralelismo seguro para **esta** máquina (sin LLM): lee RAM/CPU/carga en vivo → cuántos worktrees/workers correr a la vez. Consultalo antes de un fan-out multi-repo |
| `chamba_qa_capabilities` | `{}` | Con qué correr la QA de aceptación (sin LLM): web vs móvil (React Native / Expo), tooling E2E, y los simuladores iOS / emuladores Android realmente disponibles (read-only `xcrun simctl` / `adb` / `emulator` — lista, nunca bootea). El agente qa elige su modo con esto |
| `chamba_triage_ticket` | `{ ticket }` | Chequeo heurístico de completitud de un ticket de soporte/bug (sin LLM): `{ present, missing, questions, enoughToStart, score }` — marca si tiene reproducción, esperado-vs-actual, entorno, alcance, criterios de aceptación, severidad, con las preguntas para pedir de vuelta. Potencia `/triage` |
| `chamba_generate_plan` | `{ task, context? }` | Un template de plan para completar |
| `chamba_review_plan` | `{ plan, task, context? }` | `{ approved, issues, suggestions, riskFlags }` — sin LLM |
| `chamba_create_worktree` | `{ taskSlug, workerId, baseBranch? }` | Un git worktree aislado |
| `chamba_list_worktrees` | `{}` | Los worktrees del repo |
| `chamba_cleanup_worktree` | `{ branch }` | Borra el dir, **conserva la rama** |
| `chamba_remember` | `{ key, content, tags? }` | Persiste una memoria en markdown |
| `chamba_recall` | `{ query }` | Busca en las memorias guardadas |
| `chamba_get_agent_config` | `{ role }` | `{ model, effort, reasoning_priority, provider, hint }` por rol — sin LLM |
| `chamba_create_worktrees` | `{ ticket, repos? }` | Worktrees multi-repo para un ticket (por config); conserva ramas |
| `chamba_cleanup_worktrees` | `{ ticket, repos? }` | Borra los worktrees del ticket, **conserva todas las ramas** |

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

## Extras por editor (opcional)

Todo editor MCP tiene las tools. En **Claude Code**, **Cursor** y **OpenCode** podés además
instalar los slash commands y subagentes (mismos prompts, una sola fuente):

```bash
npx @chamba/cursor-extras@latest install     # Cursor:   /ticket, /triage, /qa … + subagentes + MCP
npx @chamba/opencode-extras@latest install   # OpenCode: /ticket, /triage, /qa … + subagentes + MCP
```

En **Claude Code** además tenés hooks:

```bash
npx @chamba/claude-extras@latest install     # /ticket, /triage, /workspace, /map, /qa, /design … +
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
- 🔭 V2: búsqueda semántica del vault, MCP sampling, más bases de conocimiento

Ver [`PLAN.md`](./PLAN.md) para el plan completo de fases.

## Requisitos

- Node 22 LTS
- pnpm 9+ (para desarrollo)
- Un editor con cliente MCP (para usar las tools)

## Licencia

MIT — ver [`LICENSE`](./LICENSE). Hecho con cariño en Colombia.
