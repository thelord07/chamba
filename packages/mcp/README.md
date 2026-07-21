# @chamba/mcp

The **chamba MCP server** — adds orchestration, workspace context, git worktrees and
Obsidian memory to any MCP-capable editor (Cursor, Claude Code, VS Code/Copilot,
Windsurf, Cline, OpenCode, Zed, JetBrains, Gemini CLI, Codex, Trae, Kiro).

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

**More editors** (full guides in the repo's [`examples/`](https://github.com/thelord07/chamba/tree/main/examples)):
Gemini CLI (`~/.gemini/settings.json`, `mcpServers`) · Codex (`~/.codex/config.toml`, TOML
`[mcp_servers.chamba]`) · JetBrains AI Assistant (`mcpServers`) · Trae (`mcpServers`) · Zed
(`~/.config/zed/settings.json`, key `context_servers`) · Kiro (`.kiro/settings/mcp.json`).

Point at an Obsidian vault with `"env": { "CHAMBA_OBSIDIAN_VAULT_PATH": "/path/to/vault" }`.
If none is set, `chamba_workspace_init` bootstraps a global vault at `~/.chamba/vault` —
**outside your repos**, so notes/memory never get committed.

## Tools

**Workspace + context:** `chamba_workspace_init` · `chamba_workspace_show` ·
`chamba_workspace_reload` · `chamba_load_context` · `chamba_load_skills`

**Design (visual tickets):** `chamba_load_design` · `chamba_design_prefs` — link a Figma
URL / mockups folder / standalone `.html`·`.zip` prototype and set the UI-architecture
preference (Atomic Design, Feature-Sliced, …). No LLM.

**Planning + review:** `chamba_generate_plan` · `chamba_review_plan` (heuristic, no LLM) ·
`chamba_save_plan`

**Worktrees (parallel work):** `chamba_create_worktree` · `chamba_create_worktrees` ·
`chamba_list_worktrees` · `chamba_cleanup_worktree` · `chamba_cleanup_worktrees`

**Memory + vault:** `chamba_remember` · `chamba_recall` · `chamba_summarize_to_vault` ·
`chamba_vault_status`

**Health + capacity:** `chamba_doctor` · `chamba_resource_budget` (safe parallelism from
live RAM/CPU) · `chamba_qa_capabilities` (web/mobile QA probe) · `chamba_get_agent_config`

Full docs, per-editor guides and examples:
**https://github.com/thelord07/chamba**

## License

MIT
