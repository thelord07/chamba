# chamba in JetBrains (AI Assistant / Junie)

Add chamba's MCP tools to JetBrains IDEs (IntelliJ IDEA, PyCharm, WebStorm, …) via
**AI Assistant** or **Junie**. The IDE's model does the reasoning; chamba provides the tools.
No API key for chamba. Requires a JetBrains IDE 2025.1+ with AI Assistant.

## 1. Add the config

Open **Settings → Tools → AI Assistant → Model Context Protocol (MCP) → Add**. Choose the
**JSON** form (labelled "As JSON" / import) and paste — JetBrains uses the standard
**`mcpServers`** key. Same block as [`mcp.json`](./mcp.json):

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

In the AI Assistant / Junie chat, confirm chamba's tools are listed, then ask:

```
Use chamba to map this workspace, then load context for "add a health check endpoint".
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
