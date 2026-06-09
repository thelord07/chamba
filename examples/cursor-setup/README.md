# chamba in Cursor

Add chamba's MCP tools to Cursor's chat. No API key — Cursor's own model does the
reasoning and calls chamba's tools.

## 1. Add the config

Copy [`.cursor/mcp.json`](./.cursor/mcp.json) into your project (project-scoped) or
into `~/.cursor/mcp.json` (global):

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

## 2. Enable it

Open **Cursor Settings → MCP**. You should see **chamba** with a green dot and its
tools listed (`chamba_workspace_init`, `chamba_load_context`, …). If it's red, click
refresh; the first run downloads the package via `npx`.

## 3. Use it

In Cursor's chat (Agent mode), just ask — the model picks the tools:

```
Use chamba to map this workspace, then load context for "add a health check endpoint".
```

```
Generate a plan for "add rate limiting to the login route", review it with chamba,
and fix anything it flags before you start.
```

```
Remember that we deploy manually on Fridays. (later) What do you recall about deploys?
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
