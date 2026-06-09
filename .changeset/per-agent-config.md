---
"@chamba/core": minor
"@chamba/adapters": minor
"@chamba/mcp": minor
"@chamba/claude-extras": minor
---

Per-agent configuration (model + effort per role).

- **core**: model catalog (Anthropic, OpenAI, Gemini, Ollama), agent roles,
  hardcoded recommended defaults, Zod schema, and a layered loader
  (defaults ← global ← project, merged per role and per field). Corrupt configs
  degrade to defaults with a warning. chamba still never calls an LLM — this is
  declarative metadata.
- **mcp**: new read-only tool `chamba_get_agent_config` exposing the resolved
  model + effort + hint per role to any MCP editor.
- **claude-extras**: subagent frontmatter (`model` + `effort`) is now generated
  from the config; an install wizard (non-blocking, CI-safe with `--defaults`)
  and a `config` CLI (`show`/`models`/`set`/`reset`/`wizard`/`apply`/`edit`) let
  you pick and reconfigure models per role. `effort` is provider-neutral
  (`low|medium|high|extreme`) and mapped per provider (e.g. `extreme` → `max`
  in Claude Code).
