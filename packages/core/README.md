# @chamba/core

Pure core logic for [chamba](https://github.com/thelord07/chamba): workspace scanner,
plan generator + heuristic reviewer, git worktree manager, Obsidian context/vault
writer, and a filesystem memory store.

- **No Node APIs directly** — all OS access goes through ports (`FilesystemPort`,
  `ProcessPort`, `ClockPort`), so it's testable and runtime-agnostic.
- **No LLM** — chamba never calls a model.
- Node implementations of the ports live in
  [`@chamba/adapters`](https://www.npmjs.com/package/@chamba/adapters).

Most users want the [`@chamba/mcp`](https://www.npmjs.com/package/@chamba/mcp) server,
not this library directly.

## License

MIT
