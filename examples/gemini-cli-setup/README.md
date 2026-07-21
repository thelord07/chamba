# chamba in Gemini CLI

Add chamba's MCP tools to the [Gemini CLI](https://github.com/google-gemini/gemini-cli).
No API key for chamba — Gemini's model does the reasoning and calls chamba's tools.

## 1. Add the config

Gemini CLI reads MCP servers from `settings.json` under the **`mcpServers`** key. Use the
project-scoped [`.gemini/settings.json`](./.gemini/settings.json) here, or merge into your
global `~/.gemini/settings.json`:

```json
{
  "mcpServers": {
    "chamba": {
      "command": "npx",
      "args": ["-y", "@chamba/mcp"]
    }
  }
}
```

## 2. Use it

Start `gemini`, then check the server loaded with `/mcp` — you should see **chamba** and its
tools. Then just ask; the model picks the tools:

```
Use chamba to map this workspace, then load context for "add a health check endpoint".
```

## Optional: Obsidian

Point chamba at your vault so `chamba_load_context` cites your notes and
`chamba_summarize_to_vault` writes summaries back:

```json
{
  "mcpServers": {
    "chamba": {
      "command": "npx",
      "args": ["-y", "@chamba/mcp"],
      "env": { "CHAMBA_OBSIDIAN_VAULT_PATH": "/Users/you/Obsidian/MyVault" }
    }
  }
}
```
