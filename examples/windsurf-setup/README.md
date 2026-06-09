# chamba in Windsurf

Add chamba to Windsurf's Cascade via MCP. Windsurf's model does the reasoning.

## 1. Add the config

Open **Windsurf Settings → Cascade → MCP Servers → Manage → View raw config**, or
edit `~/.codeium/windsurf/mcp_config.json` directly. Use the
[`mcp_config.json`](./mcp_config.json) here (Windsurf uses the `"mcpServers"` key):

```json
{
  "mcpServers": {
    "chamba": { "command": "npx", "args": ["-y", "@chamba/mcp"] }
  }
}
```

## 2. Refresh & use

Click **Refresh** in the MCP panel; chamba's tools appear in Cascade. Then ask:

```
Use chamba to init the workspace and load context for "add a CSV export endpoint".
```

## Optional: Obsidian

Add an `env` block with `CHAMBA_OBSIDIAN_VAULT_PATH` pointing at your vault, exactly
as in the Cursor example.
