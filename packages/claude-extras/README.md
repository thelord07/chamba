# @chamba/claude-extras

Optional **Claude Code** extras for [chamba](https://github.com/thelord07/chamba):
slash commands, subagents and hooks on top of the chamba MCP server.

> Cursor, VS Code and other MCP editors don't need this — they get everything via
> the [`@chamba/mcp`](https://www.npmjs.com/package/@chamba/mcp) server. This package
> is Claude-Code-specific sugar.

## Usage

```bash
npx @chamba/claude-extras install      # add commands, agents, hooks + register MCP
npx @chamba/claude-extras install --force   # overwrite existing files
npx @chamba/claude-extras uninstall    # remove them
```

It installs into `~/.claude/`:

- **Slash commands**: `/orq`, `/workspace`, `/worktrees`, `/recall`
- **Subagents**: `implementer`, `reviewer`, `tester`
- **Hooks**: warn on destructive commands, validate worktree edits

…and registers the `chamba` MCP server in `~/.claude.json`. It never overwrites your
existing files and preserves any other MCP servers.

Then, in Claude Code: `/orq add a health check endpoint`

## License

MIT
