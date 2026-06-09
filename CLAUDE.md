# chamba — Contexto de proyecto

## Qué es
chamba es un AI agent harness open-source en TypeScript. Monorepo pnpm con:
- `@chamba/core` — librería pura, sin Node APIs directas
- `@chamba/adapters` — implementaciones Node de los ports
- `@chamba/cli` — TUI con Ink, binario `chamba`
- `@chamba/server` — HTTP/SSE con Hono
- `@chamba/mcp` — MCP server, expone chamba a editores (Cursor, VS Code, Windsurf, Cline, JetBrains, Trae)

Side project público, MIT, busca tracción en GitHub y npm. Inspirado en byo-coding-agent (BettaTech), Claude Code, OpenCode, Aider.

**Diferenciadores clave:**
- Provider-agnóstico desde día uno.
- MCP de primera clase (consume MCP servers como tools).
- chamba mismo se expone como MCP server, invocable desde el chat de cualquier editor compatible.
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
- Exports nombrados, no default (excepto `bin/chamba` y `bin/chamba-mcp`).
- Archivos kebab-case: `agent-loop.ts`.
- Tipos e interfaces PascalCase.
- Funciones y variables camelCase.
- Constantes globales SCREAMING_SNAKE_CASE.
- Errores son clases extendiendo `Error` con `name` explícito.
- Cero `any` excepto en adapters de SDKs externos, justificado con comentario.

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

## Gotchas conocidos
- **MCP stdio servers no pueden escribir a stdout** fuera del protocolo. Cualquier log debe ir a archivo (`~/.chamba/logs/`) o a stderr. Esto aplica al paquete `@chamba/mcp`.
- **VS Code MCP config usa `"servers"`, no `"mcpServers"`** como Cursor y Claude Desktop. Cuidado al documentar.
- **SafeSplitPoint en compaction** es crítico: nunca separar un `tool_use` de su `tool_result` o la API devuelve 400. Cubrir con tests exhaustivos.
- **`.chamba/` del usuario es distinto del `.chamba/` del repo de chamba.** El primero lo crea chamba en el dir del usuario; el segundo solo existe en `examples/`. No confundirlos.
