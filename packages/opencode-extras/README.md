# @chamba/opencode-extras

Optional **OpenCode** extras for [chamba](https://github.com/thelord07/chamba):
slash commands and subagents on top of the chamba MCP server.

> Only need the tools? Point OpenCode at [`@chamba/mcp`](https://www.npmjs.com/package/@chamba/mcp)
> directly (see the [OpenCode setup guide](https://github.com/thelord07/chamba/tree/main/examples/opencode-setup)).
> This package adds the `/commands` and subagents on top — the same ones Claude Code gets.

## Usage

```bash
npx @chamba/opencode-extras install          # commands + subagents + register the MCP server
npx @chamba/opencode-extras install --global  # + npm i -g @chamba/mcp; launch the binary, not npx
npx @chamba/opencode-extras install --force   # overwrite existing files
npx @chamba/opencode-extras uninstall         # remove them
npx @chamba/opencode-extras --version
```

It installs into `~/.config/opencode/` (or `$OPENCODE_CONFIG_DIR`):

- **Commands** → `commands/`: `/ticket`, `/triage`, `/qa`, `/design`, `/orq`, `/map`,
  `/workspace`, `/worktrees`, `/recall`, `/vault`.
- **Subagents** → `agents/` (`mode: subagent`): `planner`, `implementer`, `reviewer`,
  `tester`, `qa`, `diagnostician`.
- **MCP server** → `chamba` under `"mcp"` in `opencode.json` (preserves any others).

Then restart OpenCode and run `/ticket ABC-123` (or `/triage`, `/qa`, …) in the TUI.

## How it relates to Claude Code

The command and subagent **prompts are shared** with `@chamba/claude-extras` — one source
of truth, translated to OpenCode's format on install:

- Commands keep `description` and the `$ARGUMENTS` body; the Claude-Code-only
  `argument-hint` is dropped.
- Subagents become `mode: subagent`, with the model emitted as OpenCode's
  provider-scoped string (`anthropic/<model>`) taken from your chamba per-agent config
  (`~/.chamba/config.json`). A non-Anthropic model is left unset so OpenCode uses its own
  default. chamba's `effort` has no OpenCode equivalent, so it's dropped.

chamba never calls a model — this only tells OpenCode's model how to delegate. Configure
the per-agent reparto with `npx @chamba/claude-extras config <show|set|preset|…>`; both
editors read the same `~/.chamba/config.json`.

## `--global` — a steadier launch

By default the MCP server is registered as `npx -y @chamba/mcp`, which re-resolves the
package from npm on **every** spawn. `install --global` runs `npm i -g @chamba/mcp` and
registers the `chamba-mcp` binary instead — no per-launch npm, so the connection is far
less likely to drop. Falls back to the npx launcher if the global install can't run.

## License

MIT
