# chamba

> An open-source **MCP server** that adds orchestrator-worker patterns, workspace
> context, git worktrees and Obsidian integration to any MCP-capable editor —
> Claude Code, Cursor, VS Code (Copilot), Windsurf, Cline, OpenCode, JetBrains, Trae.

**chamba** is the LATAM word for *work* — *la chamba*. chamba does the coordination
work so your editor's model can focus on reasoning and code.

> ⚠️ **Early days.** chamba is being built incrementally following
> [`PLAN.md`](./PLAN.md). Phase 1 (this one) ships the smallest thing that works:
> the MCP server boots over stdio and exposes one tool, `chamba_workspace_show`.

## The key idea: chamba does NOT call an LLM

chamba never talks to a model. **Your editor's model does the reasoning** and calls
chamba's tools. That means:

- **Zero API keys.** No `ANTHROPIC_API_KEY`, no `OPENAI_API_KEY`. Your editor already
  pays for its own model.
- **Every MCP editor, day one.** One implementation works in Cursor, Claude Code,
  VS Code, Windsurf, Cline, and more.
- chamba just exposes **tools and patterns**: scan workspaces, generate plan
  templates, validate them heuristically, create git worktrees, write structured
  summaries to your Obsidian vault.

## Packages

| Package | What it is |
|---|---|
| `@chamba/mcp` | **The product.** A stdio MCP server exposing chamba's tools |
| `@chamba/core` | Pure logic (workspace, plan, worktree, obsidian, memory). No Node APIs directly |
| `@chamba/adapters` | Node implementations of the ports (filesystem, process, clock) |
| `@chamba/claude-extras` | Optional: slash commands, subagents, hooks for Claude Code |

Most of these arrive in later phases. See [`PLAN.md`](./PLAN.md) for the roadmap.

## Try it (Phase 1)

```bash
git clone https://github.com/<your-org>/chamba.git
cd chamba
pnpm install
pnpm --filter @chamba/mcp build
```

Inspect the running server with the MCP Inspector — you should see one tool,
`chamba_workspace_show`:

```bash
npx @modelcontextprotocol/inspector node packages/mcp/dist/main.js
```

The tool reads `.chamba/workspace.md` from the directory where the editor launched
chamba and returns its contents (or tells you none exists yet). Creating that file
lands as a tool in Phase 2.

## Tools (so far)

| Tool | Input | Output |
|---|---|---|
| `chamba_workspace_show` | `{}` | Contents of `.chamba/workspace.md`, or a "not found" note |

The full V1 tool set (workspace init/reload, load context, plan + review, worktrees,
Obsidian summaries, memory) is detailed in [`PLAN.md`](./PLAN.md).

## Requirements

- Node 22 LTS
- pnpm 9+
- An editor with an MCP client (to actually use the tools)

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
pnpm biome check .
```

> Note for MCP authors: a stdio MCP server must never write to stdout except the
> protocol itself. chamba logs to `~/.chamba/logs/mcp-{pid}.log` via pino — never
> `console.log`. See [`packages/mcp/src/logging.ts`](./packages/mcp/src/logging.ts).

## License

MIT — see [`LICENSE`](./LICENSE). Built with cariño in LATAM.
