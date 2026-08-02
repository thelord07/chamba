# @chamba/cursor-extras

## 1.4.0

### Minor Changes

- feat(cursor): new @chamba/cursor-extras — slash commands + subagents for Cursor

  chamba's editor extras now cover **Cursor** too. A new package installs the same
  commands and subagents into Cursor and registers the MCP server.

  - `npx @chamba/cursor-extras install` writes the commands to `~/.cursor/commands/`
    (plain markdown — Cursor commands have no frontmatter), the subagents to
    `~/.cursor/agents/` (Cursor 2.4+; `name` + `description` + `model`), and adds
    `chamba` under `mcpServers` in `~/.cursor/mcp.json` (preserving any others).
    `--global`, `--force` and `uninstall` supported.
  - **Shared prompts, one source.** The command/agent bodies are the same files
    `@chamba/claude-extras` ships (copied at build time), translated to Cursor's format:
    commands drop the frontmatter, subagents take a **bare Anthropic model id** from your
    `~/.chamba/config.json` reparto (Cursor accepts `claude-opus-5`), falling back to
    `model: inherit` for non-Anthropic models; `effort` is dropped.
  - Docs: package README + updated Cursor setup guide.

### Patch Changes

- @chamba/adapters@1.4.0
- @chamba/core@1.4.0
