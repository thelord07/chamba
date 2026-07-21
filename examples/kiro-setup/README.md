# chamba in Kiro

Add chamba's MCP tools to [Kiro](https://kiro.dev/). Kiro's model does the reasoning; chamba
provides the tools. No API key for chamba.

## 1. Add the config

Kiro reads MCP servers from `mcp.json` under the **`mcpServers`** key. Use a workspace
[`.kiro/settings/mcp.json`](./.kiro/settings/mcp.json), or the user-level
`~/.kiro/settings/mcp.json` to enable it everywhere:

```json
{
  "mcpServers": {
    "chamba": {
      "command": "npx",
      "args": ["-y", "@chamba/mcp"],
      "disabled": false
    }
  }
}
```

## 2. Use it

Open the **MCP Servers** panel (or the Kiro command palette → MCP) and confirm **chamba** is
connected, then ask in chat:

```
Use chamba to load context for "add a health check endpoint", then generate and review a plan.
```

## Optional: Obsidian

```json
{
  "mcpServers": {
    "chamba": {
      "command": "npx",
      "args": ["-y", "@chamba/mcp"],
      "disabled": false,
      "env": { "CHAMBA_OBSIDIAN_VAULT_PATH": "/Users/you/Obsidian/MyVault" }
    }
  }
}
```
