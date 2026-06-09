# chamba

[![npm](https://img.shields.io/npm/v/@chamba/mcp.svg)](https://www.npmjs.com/package/@chamba/mcp)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-7c3aed.svg)](https://modelcontextprotocol.io)

> **Un MCP server que le agrega orquestación, contexto de workspace, git worktrees y
> memoria con Obsidian a cualquier editor con IA** — Cursor, Claude Code, VS Code
> (Copilot), Windsurf, Cline, OpenCode. Sin API key: el modelo de tu editor razona,
> chamba coordina.

*"Chamba"* es la palabra latina para *trabajo*. Vos le pasás la chamba al modelo;
chamba (la herramienta) se encarga de supervisar, validar y toda la plomería.

📖 [English](./README.md) · 🧩 [Guías de configuración por editor](./examples/) · 🗺️ [Roadmap](#roadmap)

> ⚠️ Pre-1.0, construido en público fase por fase ([`PLAN.md`](./PLAN.md)). El set
> completo de tools de V1 ya está implementado; falta el release y el pulido.

## La idea clave: chamba NO llama a un LLM

El modelo de tu editor hace el razonamiento y llama a las tools de chamba. Eso significa:

- **Cero API keys.** Nada de `ANTHROPIC_API_KEY` ni `OPENAI_API_KEY`.
- **Todos los editores con MCP, desde el día uno.** Un solo server stdio funciona en
  Cursor, Claude Code, VS Code, Windsurf, Cline y OpenCode.
- **Consciente del workspace.** Escanea tu proyecto a un `.chamba/workspace.md`
  editable y usa ese contexto en los planes.
- **Plan + review heurístico (sin LLM).** Detecta falta de tests, trabajo sin
  responsable, áreas sensibles sin evaluación de riesgo, y más.
- **Paralelismo seguro.** Los git worktrees aíslan el trabajo paralelo; el cleanup
  conserva las ramas para que vos las mergees a mano — nunca `--force`, nunca merge
  automático.
- **Obsidian + memoria entre sesiones.** Trae contexto de tu vault, escribe resúmenes
  de vuelta, y persiste conocimiento como markdown plano.

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

Para conectar un vault de Obsidian, agregá `"env": { "CHAMBA_OBSIDIAN_VAULT_PATH": "/ruta/al/vault" }`.

## Tools

| Tool | Input | Output |
|---|---|---|
| `chamba_workspace_init` | `{ root? }` | Escanea y escribe `.chamba/workspace.md` (no sobrescribe) |
| `chamba_workspace_show` | `{}` | Contenido de `.chamba/workspace.md` |
| `chamba_workspace_reload` | `{}` | Un diff vs un re-escaneo (sin escribir) |
| `chamba_load_context` | `{ task, includeObsidian? }` | Resumen del workspace + notas relevantes del vault |
| `chamba_summarize_to_vault` | `{ title, content, projectSlug? }` | Escribe una nota al vault |
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

## Extras para Claude Code (opcional)

Cursor/VS Code ya tienen todo vía MCP. En **Claude Code** podés además agregar slash
commands, subagents y hooks:

```bash
npx @chamba/claude-extras install     # /orq, /workspace, /worktrees, /recall +
                                      # agentes implementer/reviewer/tester + 2 hooks
npx @chamba/claude-extras uninstall
```

Idempotente, no sobrescribe tus archivos (`--force` para forzar), preserva otros MCP
servers en `~/.claude.json`. Después: `/orq agrega un endpoint de health check`.

**Config por agente.** El primer install corre un wizard para elegir modelo + esfuerzo
por rol (orchestrator, planner, reviewer, implementer, tester, summarizer, researcher),
con defaults eficientes pre-configurados — modelos potentes para razonar, rápidos y
baratos para lo mecánico. Reconfigurás con `npx @chamba/claude-extras config <show|set|wizard|…>`.
chamba sigue sin llamar a ningún modelo: esto solo le dice al modelo de tu editor cómo
delegar. Otros editores leen la misma config vía `chamba_get_agent_config`. Ver el
[README de claude-extras](./packages/claude-extras/README.md#configuration-per-agent-model--effort).

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
- 🔭 V2: búsqueda semántica del vault, MCP sampling, más bases de conocimiento

Ver [`PLAN.md`](./PLAN.md) para el plan completo de fases.

## Requisitos

- Node 22 LTS
- pnpm 9+ (para desarrollo)
- Un editor con cliente MCP (para usar las tools)

## Licencia

MIT — ver [`LICENSE`](./LICENSE). Hecho con cariño en LATAM.
