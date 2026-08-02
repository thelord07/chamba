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

## Optional: the slash commands + subagents (like Claude Code)

The MCP tools work on their own, but OpenCode also supports custom **commands** and
**subagents** — so chamba's `/ticket`, `/triage`, `/qa`, `/design`, `/orq`, … and the
`planner` / `implementer` / `reviewer` / `tester` / `qa` / `diagnostician` agents can be
installed too. One command does it (and registers the MCP server for you):

```bash
npx @chamba/opencode-extras@latest install
# or, for a steadier launch (installs @chamba/mcp globally, no npx per spawn):
npx @chamba/opencode-extras@latest install --global
```

It writes the commands to `~/.config/opencode/commands/`, the subagents to
`~/.config/opencode/agents/` (`mode: subagent`, model from your chamba reparto), and adds
`chamba` under `"mcp"` in `~/.config/opencode/opencode.json`. Restart OpenCode, then
`/ticket ABC-123` (or `/triage`, `/qa`, …) works in the TUI. `npx @chamba/opencode-extras
uninstall` removes them. The command/agent prompts are the same ones Claude Code gets —
one source, both editors.

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
