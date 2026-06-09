# chamba

> An open-source AI agent harness in TypeScript. Provider-agnostic, MCP-first,
> workspace-aware, with a built-in orchestrator-worker pattern.

**chamba** is the LATAM word for *work* — *la chamba*. The harness gives the model
its chamba: it hands over the task, supervises, validates, and takes care of all
the coordination. Built in public, phase by phase.

> ⚠️ **Early days.** chamba is being built incrementally following
> [`PLAN.md`](./PLAN.md). Phase 1 (this one) ships a deliberately tiny, abstraction-free
> agent loop so you can see the essence before the layers arrive.

## Why chamba

- **Provider-agnostic from commit one.** Swap Anthropic for OpenAI with one config change.
- **MCP as a first-class citizen.** Native tools and MCP tools share the same interface.
- **chamba is also an MCP server.** Invoke it from the chat of any MCP-capable editor
  (Cursor, VS Code, Windsurf, Cline, JetBrains, Trae).
- **Workspace-aware.** It understands the directory it runs in, and optionally your
  Obsidian vault.
- **Orchestrator-worker with a reviewer gate.** Plan → audit → execute in parallel → test → document.

## Packages

| Package | What it is |
|---|---|
| `@chamba/core` | Pure harness library: API types, providers, agent loop, tools, compaction |
| `@chamba/adapters` | Node implementations of the ports (filesystem, process, clock) |
| `@chamba/cli` | Ink TUI, the `chamba` binary |
| `@chamba/server` | HTTP/SSE server with Hono |
| `@chamba/mcp` | MCP server that exposes chamba to editors |

Most of these arrive in later phases. See [`PLAN.md`](./PLAN.md) for the roadmap.

## Step-by-step usage guide

> This section grows phase by phase. Right now it covers the minimal example only.

### Try the minimal agent (Phase 1)

The fastest way to see what a harness is. ~200 lines, one file, no abstractions:
a REPL that talks to Claude and runs `bash`, `read_file` and `write_file` tools,
asking for your approval before each one.

```bash
git clone https://github.com/<your-org>/chamba.git
cd chamba
pnpm install

ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @chamba/examples-minimal start
```

Then, at the prompt:

```
you: list the files here
  ⚡ tool: bash
     input: {"command":"ls -la"}
     approve? [y/N] y

chamba: Here are the files in the current directory ...
```

Type `/exit` to quit. The whole thing lives in
[`examples/minimal/main.ts`](./examples/minimal/main.ts) — read it, it's short.

## Requirements

- Node 22 LTS
- pnpm 9+

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
pnpm biome check .
```

## License

MIT — see [`LICENSE`](./LICENSE). Built with cariño in LATAM.
