# @chamba/claude-extras

Optional **Claude Code** extras for [chamba](https://github.com/thelord07/chamba):
slash commands, subagents and hooks on top of the chamba MCP server.

> Cursor, VS Code and other MCP editors don't need this — they get everything via
> the [`@chamba/mcp`](https://www.npmjs.com/package/@chamba/mcp) server. This package
> is Claude-Code-specific sugar.

## Usage

```bash
npx @chamba/claude-extras install      # add commands, agents, hooks + register MCP
npx @chamba/claude-extras install --force   # overwrite existing files
npx @chamba/claude-extras uninstall    # remove them
```

It installs into `~/.claude/`:

- **Slash commands**: `/orq`, `/workspace`, `/worktrees`, `/recall`
- **Subagents**: `implementer`, `reviewer`, `tester`
- **Hooks**: warn on destructive commands, validate worktree edits

…and registers the `chamba` MCP server in `~/.claude.json`. It never overwrites your
existing files and preserves any other MCP servers.

Then, in Claude Code: `/orq add a health check endpoint`

## Configuration: per-agent model + effort

chamba lets you pick which **model** and **effort** each **role** uses
(orchestrator, planner, reviewer, implementer, tester, summarizer, researcher).

> **chamba never calls these models.** This config is declarative metadata. For
> Claude Code it's written into each subagent's frontmatter (`model:` + `effort:`)
> in `~/.claude/agents/*.md`; Claude Code is what runs the model. Other editors read
> the same config through the MCP tool `chamba_get_agent_config`. No API keys, ever.

### The recommended defaults (and why)

The philosophy: **critical reasoning gets powerful models, mechanical execution gets
fast/cheap ones.** These ship pre-configured — you only change what you want.

| Role | Default model | Effort | Why |
|---|---|---|---|
| **orchestrator** | `claude-opus-4-8` | high | The brain: decomposes, plans, decides. Worth the tokens. |
| **planner** | `claude-opus-4-8` | extreme | Max reasoning when planning is delegated. Invoked rarely. |
| **reviewer** | `claude-opus-4-7` | high | Critical audit; deep reasoning, doesn't need the very latest model. |
| **implementer** | `claude-sonnet-4-6` | medium | Executes clear specs; speed matters, medium reasoning is enough. |
| **tester** | `claude-sonnet-4-6` | medium | Tests over already-implemented code; same profile. |
| **summarizer** | `claude-haiku-4-5` | low | Summaries are mechanical; a fast, cheap model is perfect. |
| **researcher** | `claude-opus-4-7` | high | Research + synthesis; high reasoning, doesn't need Opus 4.8. |

### The wizard

The first `install` offers an interactive wizard (skipped automatically with
`--defaults` or in non-TTY/CI environments — defaults apply, install never blocks):

```text
chamba per-agent config
Pick which model + effort each role uses. …

? Use the recommended defaults? (No lets you customize each role) (Y/n)
```

Pick **Yes** to take the table above, or **No** to choose a model + effort for each
role. Cancelling (Ctrl+C) installs the defaults anyway.

### Reconfigure anytime

```bash
npx @chamba/claude-extras config show                  # resolved config + where each value comes from
npx @chamba/claude-extras config models                # list available models
npx @chamba/claude-extras config set tester claude-haiku-4-5 --effort low
npx @chamba/claude-extras config apply                 # regenerate ~/.claude/agents from the config
npx @chamba/claude-extras config wizard                # re-run the wizard
npx @chamba/claude-extras config reset --yes           # back to defaults
npx @chamba/claude-extras config edit                  # open ~/.chamba/config.json in $EDITOR
```

### Override per project

`~/.chamba/config.json` is your global config; a `./.chamba/config.json` in a repo
overrides it **per role and per field**. Example — use a cheaper reviewer in one repo:

```json
{ "version": 1, "overrides": { "reviewer": { "model": "claude-sonnet-4-6" } } }
```

Every other role still falls back to your global config, then to the defaults.

### How `effort` maps per provider

`effort` is provider-neutral (`low | medium | high | extreme`); chamba translates it:

| `effort` | Claude Code | OpenAI (`reasoning_effort`) | Gemini (`thinkingLevel`) | Ollama |
|---|---|---|---|---|
| low | low | low | low | n/a (model-defined) |
| medium | medium | medium | medium | n/a |
| high | high | high | high | n/a |
| extreme | **max** | **xhigh** | high | n/a |

The subagent frontmatter always uses Claude Code's vocabulary, so `extreme` → `max`.
If you set a **non-Anthropic** model for a Claude Code subagent, Claude Code can't run
it, so `model:` is omitted (the subagent inherits the session model) and a comment
records why — the config still drives every other editor through the MCP tool.

### FAQ

- **Why so many different models?** Different roles need different things. Spending
  Opus-tier reasoning on a one-line summary is waste; using Haiku to plan an
  architecture is a false economy. The defaults encode that trade-off.
- **How do I change one role without re-running the wizard?**
  `config set <role> <model> [--effort <level>]`, then `config apply`.
- **What if my config gets corrupted?** chamba degrades to the compiled defaults and
  surfaces a warning (`config show` marks the source as `IGNORED`). Nothing breaks.
- **Why does `extreme` become `max` in Claude Code?** Claude Code's effort scale tops
  out at `max`; `extreme` is chamba's name for "the ceiling".

## Multi-repo worktrees + the `/ticket` flow

If you work in a **workspace of several repos** (a parent dir with N git repos), chamba
can create an isolated worktree per repo for a ticket, reuse or fork the branch, copy
git-ignored `.env*` files, and write a `.code-workspace` — all driven by config.

```bash
npx @chamba/claude-extras config worktrees init   # interactive setup
npx @chamba/claude-extras config worktrees show   # inspect the resolved policy
```

This writes a `worktrees` block to `~/.chamba/config.json` (or per project in
`./.chamba/config.json`):

```json
{
  "version": 1,
  "worktrees": {
    "layout": "sibling",
    "root": "WORKTREES",
    "branchPrefix": "ticket/",
    "baseBranch": "main",
    "copyEnvFiles": true,
    "editorWorkspace": "code-workspace",
    "repos": ["api", "web", "functions"]
  }
}
```

- **layout** — `sibling` puts everything under `<workspace>/WORKTREES/<ticket>/<repo>`;
  `nested` puts a worktree under each repo.
- **repos** — omit to autodetect the workspace's git repos.
- **command** — escape hatch: set it to your own script (e.g.
  `"./ticket-create.sh {ticket} {repos}"`) and chamba shells out instead of using the
  built-in. Migrate from a bespoke script to config whenever you want.

Then, in Claude Code:

```
/ticket TICKET-123
```

`/ticket` runs the full orchestrator-worker flow: create worktrees →
`chamba_load_context` → delegate the plan to the **planner** subagent →
`chamba_review_plan` + the **reviewer** subagent → delegate code to **implementer** and
tests to **tester** (all inside the worktrees) → `chamba_summarize_to_vault`. It runs to
the end and stops for your review. It **never commits, merges or pushes** — you review,
commit and send to code review by hand. Each worker runs with the model + effort you
configured above.

> **Security:** `copyEnvFiles` copies secrets into the worktree directories. Add your
> `worktrees.root` (e.g. `WORKTREES/`) to `.gitignore` so they're never committed. It's
> off by default.

## License

MIT
