# chamba in VS Code (GitHub Copilot)

Use chamba's tools from Copilot Chat in **Agent mode**. Copilot's model does the
reasoning; chamba provides the tools. No API key for chamba.

## ⚠️ The one gotcha: it's `"servers"`, not `"mcpServers"`

Cursor, Claude Code and Claude Desktop use a top-level **`"mcpServers"`** key.
**VS Code uses `"servers"`** and each entry needs a `"type"`. Copy this into
[`.vscode/mcp.json`](./.vscode/mcp.json) (project) or your user `mcp.json`:

```json
{
  "servers": {
    "chamba": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@chamba/mcp"]
    }
  }
}
```

If you paste a Cursor-style `"mcpServers"` block here, VS Code silently ignores it.

## Use it

1. Open the Chat view and switch the mode dropdown to **Agent**.
2. Click the tools icon — **chamba**'s tools should be listed and toggled on.
3. Ask:

```
Use chamba to load context for "add pagination to the users endpoint", then
generate and review a plan.
```

## Optional: Obsidian

```json
{
  "servers": {
    "chamba": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@chamba/mcp"],
      "env": { "CHAMBA_OBSIDIAN_VAULT_PATH": "/Users/you/Obsidian/MyVault" }
    }
  }
}
```
