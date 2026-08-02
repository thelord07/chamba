# @chamba/cursor-extras

Optional **Cursor** extras for [chamba](https://github.com/thelord07/chamba):
slash commands and subagents on top of the chamba MCP server.

> Only need the tools? Point Cursor at [`@chamba/mcp`](https://www.npmjs.com/package/@chamba/mcp)
> directly (see the [Cursor setup guide](https://github.com/thelord07/chamba/tree/main/examples/cursor-setup)).
> This package adds the `/commands` and subagents on top — the same ones Claude Code gets.

## Usage

```bash
npx @chamba/cursor-extras@latest install          # commands + subagents + register the MCP server
npx @chamba/cursor-extras@latest install --global  # + npm i -g @chamba/mcp; launch the binary, not npx
npx @chamba/cursor-extras@latest install --force   # overwrite existing files
npx @chamba/cursor-extras@latest uninstall         # remove them
npx @chamba/cursor-extras@latest --version
```

Requires **Cursor 2.4+** for subagents (commands work from 1.6). It installs into `~/.cursor/`:

- **Commands** → `commands/`: `/ticket`, `/triage`, `/qa`, `/design`, `/orq`, `/map`,
  `/workspace`, `/worktrees`, `/recall`, `/vault`.
- **Subagents** → `agents/`: `planner`, `implementer`, `reviewer`, `tester`, `qa`,
  `diagnostician`.
- **MCP server** → `chamba` under `mcpServers` in `~/.cursor/mcp.json` (preserves any others).

Then restart Cursor and type `/` in the Agent input — `/ticket`, `/triage`, `/qa`, … are there.

## How it relates to Claude Code

The command and subagent **prompts are shared** with `@chamba/claude-extras` — one source
of truth, translated to Cursor's format on install:

- **Commands** become plain markdown (Cursor commands have no frontmatter): the body is the
  prompt, the filename is the command name. `$ARGUMENTS` is kept — you type your request when
  invoking.
- **Subagents** get `name` + `description` + `model`. Cursor accepts a bare Anthropic model
  id, so the model from your chamba per-agent config (`~/.chamba/config.json`) is passed
  through when it's Anthropic; otherwise `model: inherit` lets Cursor use the parent agent's
  model. chamba's `effort` has no stable Cursor equivalent, so it's dropped.

chamba never calls a model — this only tells Cursor's model how to delegate. Configure the
per-agent reparto with `npx @chamba/claude-extras config <show|set|preset|…>`; every editor
reads the same `~/.chamba/config.json`.

## `--global` — a steadier launch

By default the MCP server is registered as `npx -y @chamba/mcp`, which re-resolves the
package from npm on **every** spawn. `install --global` runs `npm i -g @chamba/mcp` and
registers the `chamba-mcp` binary instead — no per-launch npm. Falls back to the npx
launcher if the global install can't run.

## License

MIT
