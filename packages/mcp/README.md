# @chamba/mcp

The **chamba MCP server** — adds orchestration, workspace context, git worktrees and
Obsidian memory to any MCP-capable editor (Cursor, Claude Code, VS Code/Copilot,
Windsurf, Cline, OpenCode).

**No API key.** chamba never calls an LLM — your editor's model does the reasoning
and calls these tools.

## Install (in your editor)

**Cursor** — `.cursor/mcp.json`:

```json
{ "mcpServers": { "chamba": { "command": "npx", "args": ["-y", "@chamba/mcp"] } } }
```

**Claude Code**: `claude mcp add chamba -- npx -y @chamba/mcp`

**VS Code** — `.vscode/mcp.json` (note: VS Code uses `"servers"`, not `"mcpServers"`):

```json
{ "servers": { "chamba": { "type": "stdio", "command": "npx", "args": ["-y", "@chamba/mcp"] } } }
```

Point at an Obsidian vault with `"env": { "CHAMBA_OBSIDIAN_VAULT_PATH": "/path/to/vault" }`.

## Tools

`chamba_workspace_init` · `chamba_workspace_show` · `chamba_workspace_reload` ·
`chamba_load_context` · `chamba_summarize_to_vault` · `chamba_generate_plan` ·
`chamba_review_plan` · `chamba_create_worktree` · `chamba_list_worktrees` ·
`chamba_cleanup_worktree` · `chamba_remember` · `chamba_recall`

Full docs, per-editor guides and examples:
**https://github.com/thelord07/chamba**

## License

MIT
