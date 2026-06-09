# @chamba/claude-extras

## 0.1.0

### Minor Changes

- First public release of chamba: an MCP server that adds orchestration, workspace
  context, git worktrees and Obsidian memory to any MCP-capable editor — no API key,
  the editor's model does the reasoning.

  Twelve tools: workspace init/show/reload, load context, summarize to vault, generate
  plan, review plan (heuristic, no LLM), create/list/cleanup worktree, remember, recall.
  Plus the optional `@chamba/claude-extras` installer (slash commands, subagents, hooks)
  for Claude Code.

### Patch Changes

- Updated dependencies
  - @chamba/core@0.1.0
  - @chamba/adapters@0.1.0
