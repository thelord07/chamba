# chamba in OpenCode

OpenCode speaks MCP too. Its config shape differs from the others: MCP servers go
under `"mcp"`, each with `"type": "local"` and the command as an **array**.

## 1. Add the config

Copy [`opencode.json`](./opencode.json) to your project root (or merge into your
existing `opencode.json` / `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "chamba": {
      "type": "local",
      "command": ["npx", "-y", "@chamba/mcp"],
      "enabled": true
    }
  }
}
```

## 2. Use it

Start `opencode`, then ask in the TUI:

```
Use chamba to load context for "add a health check endpoint" and review a plan.
```

## Optional: Obsidian

Add an `"environment"` object to the server entry:

```json
"chamba": {
  "type": "local",
  "command": ["npx", "-y", "@chamba/mcp"],
  "environment": { "CHAMBA_OBSIDIAN_VAULT_PATH": "/Users/you/Obsidian/MyVault" },
  "enabled": true
}
```
