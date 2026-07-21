# Plan — Tier 3 · #3: Más editores (examples/ + detección de reglas)

> Estado: ✅ Completada — 0.17.0 · Respeta los 10 principios (cero LLM).

## Idea
chamba es MCP-first: "soportar" un editor = un snippet de config + detectar sus archivos de
reglas. Sumamos 6 editores que faltaban: **Gemini CLI, Codex, JetBrains (AI Assistant/Junie),
Trae, Zed, Kiro**. Barato, agranda el alcance, sin tocar el core de las tools.

## Cambios

### A. Core — detección de reglas de más editores (`rules.ts`)
- `RULE_SOURCES` suma: **Gemini CLI** (`GEMINI.md`), **JetBrains Junie** (`.junie/guidelines.md`),
  **Kiro** (`.kiro/steering`, dir), **Zed** (`.rules`, file). (Trae y Copilot ya estaban.)
- Test `rules.test.ts`: detecta las 4 nuevas convenciones.

### B. examples/ — guías de setup (una por editor)
Mismo esqueleto que las existentes (H1 `# chamba in <Editor>`, intro "el modelo de tu editor
razona", bloque de config, uso, Optional Obsidian). Flagear la diferencia de clave cuando aplica:
- `examples/gemini-cli-setup/` — `~/.gemini/settings.json`, clave `mcpServers`.
- `examples/codex-setup/` — `~/.codex/config.toml`, tabla TOML `[mcp_servers.chamba]` (outlier).
- `examples/jetbrains-setup/` — Settings → Tools → AI Assistant → MCP, `mcpServers`.
- `examples/trae-setup/` — Trae Settings → MCP (o `.trae/mcp.json`), `mcpServers`.
- `examples/zed-setup/` — `~/.config/zed/settings.json`, clave **`context_servers`** (outlier).
- `examples/kiro-setup/` — `.kiro/settings/mcp.json`, `mcpServers` (+ `disabled: false`).

### C. Docs — listas de editores
- README.md / README.es.md: "works with" list + bullet "Every MCP editor" + bloque de setup con
  una línea "More editors →" que enlaza las guías nuevas.
- packages/mcp/README.md: "works with" list.
- docs/index.html: `EDITORS` (tabs del matcher de config) + `EDITOR_DESCS` (ES/EN) + `editorPills`
  + bullet "Every MCP editor" + `VERSION` → 0.17.0 + línea de timeline.
- **CLAUDE.md NO se toca** (regla del proyecto: preguntar antes).

## Verificación
1. `pnpm -r build && pnpm -r test` verde (rules.test nuevo).
2. `detectRuleSources` encuentra GEMINI.md / .junie/guidelines.md / .kiro/steering/* / .rules.
3. Landing JS parsea (`node --check`) con los tabs nuevos; VERSION 0.17.0.

## Release
Minor (nueva detección de editores + docs) → changeset `@chamba/core` → lockstep **0.17.0**.
