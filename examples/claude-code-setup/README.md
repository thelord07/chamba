# chamba in Claude Code

chamba runs as an MCP server; Claude Code calls its tools using your Claude
subscription. No extra API key.

## 1. Add the MCP server

Easiest — let Claude Code register it for you:

```bash
claude mcp add chamba -- npx -y @chamba/mcp
```

Or commit a project-scoped [`.mcp.json`](./.mcp.json) so your whole team gets it:

```json
{
  "mcpServers": {
    "chamba": { "command": "npx", "args": ["-y", "@chamba/mcp"] }
  }
}
```

Verify with `/mcp` inside Claude Code — you should see **chamba** connected.

## 2. (Optional) Install the Claude Code extras

Cursor/VS Code users get everything via MCP. On Claude Code you can also add slash
commands, subagents and hooks:

```bash
npx @chamba/claude-extras install
```

This adds `/orq`, `/workspace`, `/worktrees`, `/recall`, the
implementer/reviewer/tester subagents, two hooks, and registers the chamba MCP
server in `~/.claude.json`. Remove with `npx @chamba/claude-extras uninstall`.

## 3. Use it

With the extras installed:

```
/orq add a health check endpoint
```

`/orq` walks the full flow: load context → generate plan → review plan (and fix
issues) → wait for your approval → create a worktree → implement → test →
summarize to your vault.

Without the extras, just ask in plain language:

```
Use chamba: load context for "add auth with magic links", generate a plan, and
review it before we start.
```
