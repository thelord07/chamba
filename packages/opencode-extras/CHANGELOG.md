# @chamba/opencode-extras

## 1.4.0

### Patch Changes

- @chamba/adapters@1.4.0
- @chamba/core@1.4.0

## 1.3.0

### Minor Changes

- feat(opencode): new @chamba/opencode-extras — slash commands + subagents for OpenCode

  chamba's editor extras now cover **OpenCode**, not just Claude Code. A new package
  installs the same commands and subagents into OpenCode and registers the MCP server.

  - `npx @chamba/opencode-extras install` writes the commands to
    `~/.config/opencode/commands/`, the subagents to `~/.config/opencode/agents/`
    (`mode: subagent`), and adds `chamba` under `"mcp"` in `opencode.json` (preserving
    any others). `--global`, `--force` and `uninstall` supported.
  - **Shared prompts, one source.** The command/agent bodies are the same files
    `@chamba/claude-extras` ships (copied at build time), translated to OpenCode's format:
    `argument-hint` dropped, agents get `mode: subagent` and a provider-scoped model
    (`anthropic/<id>`) from your `~/.chamba/config.json` reparto; non-Anthropic models are
    left unset so OpenCode uses its default; `effort` is dropped.
  - Docs: package README + updated OpenCode setup guide.

### Patch Changes

- @chamba/adapters@1.3.0
- @chamba/core@1.3.0
