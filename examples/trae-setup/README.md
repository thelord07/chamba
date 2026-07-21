# chamba in Trae

Add chamba's MCP tools to [Trae](https://www.trae.ai/). Trae's model does the reasoning;
chamba provides the tools. No API key for chamba.

## 1. Add the config

Open **Settings → MCP → Add → Add Manually** and paste the block below — Trae uses the
standard **`mcpServers`** key. You can also keep it in a project
[`.trae/mcp.json`](./.trae/mcp.json):

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

In Trae's chat (Builder/Agent mode), confirm **chamba** is connected, then ask:

```
Use chamba to load context for "add rate limiting to the login route", then
generate and review a plan.
```

## Optional: Obsidian

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
