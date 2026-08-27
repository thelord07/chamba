# @chamba/cursor-extras

## 1.5.0

### Minor Changes

- 70f3cce: Safe parallelism 2.0: worktree status + file overlap, merge-tree conflict preview (never merges), partition waves, and opt-in per-worktree PORT in `.env.local`.

### Patch Changes

- Updated dependencies [70f3cce]
  - @chamba/core@1.5.0
  - @chamba/adapters@1.5.0

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
