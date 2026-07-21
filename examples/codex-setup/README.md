# chamba in Codex CLI

Add chamba's MCP tools to the [Codex CLI](https://github.com/openai/codex). Codex's model
does the reasoning; chamba provides the tools. No API key for chamba.

## ⚠️ The one gotcha: Codex config is TOML, not JSON

Cursor, Windsurf and most editors use a JSON `mcpServers` block. **Codex uses TOML** in
`~/.codex/config.toml`, with servers under `[mcp_servers.<name>]`. Copy from
[`config.toml`](./config.toml):

```toml
[mcp_servers.chamba]
command = "npx"
args = ["-y", "@chamba/mcp"]
```

If you paste a JSON `mcpServers` block into `config.toml`, Codex won't parse it.

## Use it

Run `codex`, then ask — the model picks the tools:

```
Use chamba to load context for "add pagination to the users endpoint", then
generate and review a plan.
```

## Optional: Obsidian

Add an `env` table under the server so chamba can read/write your vault:

```toml
[mcp_servers.chamba]
command = "npx"
args = ["-y", "@chamba/mcp"]

[mcp_servers.chamba.env]
CHAMBA_OBSIDIAN_VAULT_PATH = "/Users/you/Obsidian/MyVault"
```
