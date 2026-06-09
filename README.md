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

## Try it

```bash
git clone https://github.com/<your-org>/chamba.git
cd chamba
pnpm install
pnpm -r build
```

Inspect the running server with the MCP Inspector — you should see the workspace
tools:

```bash
npx @modelcontextprotocol/inspector node packages/mcp/dist/main.js
```

Then, from any directory, `chamba_workspace_init` scans the project and writes a
human-editable `.chamba/workspace.md` (languages, framework, conventions, active
projects, folder map). It respects `.gitignore`/`.dockerignore` and never reads
`node_modules` or binaries. `chamba_workspace_show` returns it, and
`chamba_workspace_reload` re-scans and returns a **diff** — it never overwrites your
hand edits.

## Tools (so far)

| Tool | Input | Output |
|---|---|---|
| `chamba_workspace_init` | `{ root?: string }` | Scans and writes `.chamba/workspace.md`; if it exists, returns current contents without overwriting |
| `chamba_workspace_show` | `{}` | Contents of `.chamba/workspace.md`, or a "not found" note |
| `chamba_workspace_reload` | `{}` | A diff between the current `.chamba/workspace.md` and a fresh re-scan (no writes) |
| `chamba_load_context` | `{ task, includeObsidian? }` | Workspace summary plus Obsidian notes relevant to the task |
| `chamba_summarize_to_vault` | `{ title, content, projectSlug? }` | Writes a structured note to the vault under `proyectos/<date>-<slug>.md` |
| `chamba_generate_plan` | `{ task, context? }` | A structured plan template (goal, acceptance criteria, subtasks, risks) for the model to fill |
| `chamba_review_plan` | `{ plan, task, context? }` | Heuristic review: `{ approved, issues, suggestions, riskFlags }` — no LLM |
| `chamba_create_worktree` | `{ taskSlug, workerId, baseBranch? }` | Creates an isolated git worktree on `chamba/<date>-<task>/<worker>` (or a clear error if not a git repo) |
| `chamba_list_worktrees` | `{}` | Lists the repo's worktrees (path, HEAD, branch) |
| `chamba_cleanup_worktree` | `{ branch }` | Removes the worktree dir but **keeps the branch** (no `--force`, no merge) |

The full V1 tool set (memory) is detailed in [`PLAN.md`](./PLAN.md).

### Git worktrees for safe parallelism

`chamba_create_worktree` gives each task/worker its own git worktree so parallel
work never steps on the same files. Cleanup is deliberately conservative: it runs
`git worktree remove` **without `--force`** (a dirty worktree fails loudly) and
**never deletes the branch or merges** — the branch stays open for you to review and
`git merge --no-ff` by hand. Isolation by chamba, control by you.

### Heuristic plan review (no LLM)

`chamba_review_plan` checks a plan's *structure* with plain code — never a model.
It flags missing acceptance criteria, no tests, subtasks without an assigned
worker, vague/placeholder steps, files outside the workspace map, and sensitive
areas (auth / payments / migrations) lacking a risk assessment. The editor's model
reads the verdict and decides whether to re-plan.

## Obsidian

chamba detects an Obsidian vault from `CHAMBA_OBSIDIAN_VAULT_PATH` or common
locations (`~/Documents`, `~/Notes`, `~/Obsidian`). With a vault present,
`chamba_load_context` cites notes relevant to your task and `chamba_summarize_to_vault`
writes structured summaries back — your "second brain" and your agent, in sync.
See [`examples/obsidian-orchestrator`](./examples/obsidian-orchestrator) for a
runnable demo vault. Without a vault, `chamba_summarize_to_vault` fails with a clear
message.

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
