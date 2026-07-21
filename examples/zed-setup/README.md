# chamba in Zed

Add chamba's MCP tools to [Zed](https://zed.dev/)'s Agent Panel. Zed's model does the
reasoning; chamba provides the tools. No API key for chamba.

## ⚠️ The one gotcha: it's `"context_servers"`, not `"mcpServers"`

Zed calls MCP servers **context servers**. In `~/.config/zed/settings.json` (or **Settings →
open `settings.json`**), add them under the top-level **`"context_servers"`** key — a custom
one needs `"source": "custom"`. Copy from [`settings.json`](./settings.json):

```json
{
  "context_servers": {
    "chamba": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "@chamba/mcp"]
    }
  }
}
```

A `"mcpServers"` block won't be read here. (Zed's MCP schema has shifted across versions — if
it doesn't connect, check **Agent Panel → Settings → MCP Servers** for the current shape.)

## Use it

Open the Agent Panel, confirm **chamba** shows as connected, then ask:

```
Use chamba to map this workspace, then load context for "add a health check endpoint".
```

## Optional: Obsidian

```json
{
  "context_servers": {
    "chamba": {
      "source": "custom",
      "command": "npx",
      "args": ["-y", "@chamba/mcp"],
      "env": { "CHAMBA_OBSIDIAN_VAULT_PATH": "/Users/you/Obsidian/MyVault" }
    }
  }
}
```
