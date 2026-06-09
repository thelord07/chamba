# Example: Obsidian + chamba

A tiny Obsidian vault (`vault/`) with a couple of pre-existing notes, used to
demo chamba's Obsidian integration:

- `chamba_load_context` reads your workspace and surfaces vault notes relevant to
  a task (keyword search).
- `chamba_summarize_to_vault` writes a structured summary note back into the vault
  under `vault/proyectos/<date>-<slug>.md`.

The vault is a real Obsidian vault — note the `vault/.obsidian/` marker.

## Run it

Build chamba and point it at this vault via `CHAMBA_OBSIDIAN_VAULT_PATH`:

```bash
# from the repo root
pnpm -r build

CHAMBA_OBSIDIAN_VAULT_PATH="$PWD/examples/obsidian-orchestrator/vault" \
  npx @modelcontextprotocol/inspector node packages/mcp/dist/main.js
```

Then, in the Inspector:

1. Call `chamba_load_context` with
   `{ "task": "add authentication with magic links" }`.
   The result cites `notas/auth-decisions.md` — chamba found the relevant note.

2. Call `chamba_summarize_to_vault` with
   `{ "title": "Auth implementation", "content": "We added magic-link auth..." }`.
   A new note appears in `vault/proyectos/`.

## Non-interactive (CLI) equivalent

```bash
VAULT="$PWD/examples/obsidian-orchestrator/vault"

CHAMBA_OBSIDIAN_VAULT_PATH="$VAULT" npx @modelcontextprotocol/inspector --cli \
  node packages/mcp/dist/main.js \
  --method tools/call --tool-name chamba_summarize_to_vault \
  --tool-arg title="Auth implementation" --tool-arg content="We added magic-link auth."
```

> The model in your editor (Cursor, Claude Code, …) is what decides *when* to call
> these tools. chamba just provides the context and the writing — no LLM, no API key.
