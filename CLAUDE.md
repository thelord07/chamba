# chamba — Contexto de proyecto

## Qué es
chamba es un **MCP server open-source** en TypeScript que expone tools de orquestación, workspace, worktrees y Obsidian a cualquier editor compatible con MCP (Claude Code, Cursor, VS Code con Copilot, Windsurf, Cline, OpenCode, JetBrains, Trae).

Monorepo pnpm con:
- `@chamba/core` — lógica pura sin Node APIs directas (workspace, plan, worktree, obsidian, memory).
- `@chamba/adapters` — implementaciones Node de los ports.
- `@chamba/mcp` — **el producto principal**: MCP server stdio que expone las tools.
- `@chamba/claude-extras` — opcional: slash commands, subagents, hooks para Claude Code específicamente.

Side project público, MIT, busca tracción en GitHub y npm.

**Diferenciadores clave:**
- **chamba NO llama LLMs.** El razonamiento lo hace el modelo del editor que invoca las tools. Cero API keys requeridas.
- Funciona en TODOS los editores con MCP client desde el día uno (no solo Claude Code).
- Workspace-aware con `.chamba/workspace.md` editable.
- Git worktrees para aislamiento real de trabajo paralelo, sin merge ni delete automáticos.
- Integración profunda con Obsidian (búsqueda de contexto + escritura de resúmenes).
- Reviewer heurístico programático (sin LLM, valida estructura del plan).

## Principios no-negociables
Lee PLAN.md sección 2. Los 10 principios son ley. El más importante:

**chamba NO importa SDKs de LLM.** Cero `@anthropic-ai/sdk`, cero `openai`, cero equivalente. Si te encuentras escribiendo una llamada a un modelo dentro del repo, estás violando el principio fundamental. El modelo del cliente hace ese trabajo.

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
5. Ambas ubicaciones deben estar siempre sincronizadas.
6. El commit que cierra una fase debe incluir el update a PLAN.md como parte del mismo commit.

## Actualizaciones incrementales al README
El README crece fase por fase. Cada fase que añade tools al MCP server debe actualizar el README documentando las tools nuevas. La Fase 8 es el polish final, no la escritura desde cero.

## Stack confirmado
- Node 22 LTS, TypeScript 5.6+
- pnpm workspaces
- vitest, biome, tsup
- zod, neverthrow, pino
- @modelcontextprotocol/sdk (ÚNICO SDK externo permitido)
- **NO uses:** @anthropic-ai/sdk, openai, NestJS, LangChain, Mastra, Vercel AI SDK, Hono, Express, ESLint+Prettier

## Comandos comunes
- `pnpm install`
- `pnpm -r build`
- `pnpm -r test`
- `pnpm --filter @chamba/mcp test`
- `pnpm biome check .`
- `pnpm biome check --write .`
- `pnpm changeset` — registrar cambio para release
- `pnpm changeset version` — bump versions
- `pnpm changeset publish` — release a npm

## Convenciones de código
- Exports nombrados, no default (excepto `bin/chamba-mcp` y `bin/chamba-install`).
- Archivos kebab-case: `workspace-init.ts`.
- Tipos e interfaces PascalCase.
- Funciones y variables camelCase.
- Constantes globales SCREAMING_SNAKE_CASE.
- Errores son clases extendiendo `Error` con `name` explícito.
- Cero `any` excepto justificado con comentario.

## Estructura de tests
- Co-located: `scanner.test.ts` junto a `scanner.ts`.
- Sufijo `.test.ts`.
- Usar `FilesystemPort` en memoria para tests de IO.

## Cuándo preguntar al humano
- Antes de saltarse fases del plan.
- Antes de añadir dependencias no listadas en PLAN.md sección 4.
- Antes de violar uno de los principios de PLAN.md sección 2 (especialmente el #1).
- Antes de modificar este CLAUDE.md o PLAN.md.
- Si los acceptance criteria fallan después de 2 intentos honestos.

## Tono del proyecto
- chamba es un proyecto LATAM, sin pena. README en inglés y español.
- Tono claro, directo, sin marketing-bullshit.
- En español, voseo o tuteo neutral. Sin chilenismos ni mexicanismos exclusivos.
- En inglés, técnico pero accesible. Sin "revolutionize", "leverage", "synergy".

## Gotchas conocidos
- **MCP stdio servers no pueden escribir a stdout** fuera del protocolo. Logs a `~/.chamba/logs/mcp-{pid}.log` vía pino. NUNCA `console.log()`. Esto es el footgun que más cuesta debuggear.
- **VS Code MCP config usa `"servers"`, no `"mcpServers"`** como Cursor y Claude Desktop. Documentar siempre la diferencia.
- **`.chamba/` del usuario es distinto del repo de chamba.** El primero lo crea chamba en el dir del usuario; el segundo no existe excepto en `examples/`.
- **Worktrees solo se crean en repos git.** Antes de crear, verificar con `git rev-parse --is-inside-work-tree`. Si no es git, las tools de worktree devuelven error claro.
- **Cleanup de worktree NO borra la rama.** Solo `git worktree remove` sin `--force`. La rama queda viva para que el humano revise y mergee a mano. Bajo ninguna circunstancia chamba ejecuta `git branch -D` o `git merge` automáticamente.
- **No usar `--force` en `git worktree remove` por defecto.** Si hay cambios sin commit, queremos que falle y avise, no borrar silenciosamente.
- **El reviewer es heurístico, NO usa LLM.** Si te encuentras pensando "esto se resolvería mejor llamando un modelo", para y replantea — el cliente ya tiene un modelo, nosotros solo validamos estructura.
