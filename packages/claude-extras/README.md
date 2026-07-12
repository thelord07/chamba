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
npx @chamba/claude-extras rollback     # undo the last --force / uninstall
npx @chamba/claude-extras --version    # print the installed version
```

Check the MCP server's version the same way: `npx @chamba/mcp --version`.

**Safe by default — rollback.** Before an `install --force` or an `uninstall`, chamba
snapshots the current state it manages (`~/.claude.json` + the installed commands, agents
and hooks) under `~/.chamba/backups/`. If an overwrite or removal wasn't what you wanted,
`rollback` restores it:

```bash
npx @chamba/claude-extras rollback            # restore the most recent snapshot
npx @chamba/claude-extras rollback --list     # list snapshots (newest first)
npx @chamba/claude-extras rollback <id>       # restore a specific snapshot
npx @chamba/claude-extras rollback --pin <id> # protect one from pruning
```

Snapshots dedup by content and the newest 5 (plus any pinned) are kept.

It installs into `~/.claude/`:

- **Slash commands**: `/ticket`, `/workspace`, `/map`, `/qa`, `/worktrees`, `/orq`, `/recall`, `/vault`
- **Subagents**: `planner`, `implementer`, `reviewer`, `tester`, `qa`
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
| **qa** | `claude-opus-4-7` | high | Acceptance QA: reasons about criteria and drives the running app. |
| **summarizer** | `claude-haiku-4-5` | low | Summaries are mechanical; a fast, cheap model is perfect. |
| **researcher** | `claude-opus-4-7` | high | Research + synthesis; high reasoning, doesn't need Opus 4.8. |

**Claude Fable 5** (`claude-fable-5`) is in the catalog as an **opt-in premium** model —
assign it to a role by hand; it's never a default. Two caveats chamba surfaces (wizard,
config hint, subagent frontmatter): it costs **~2× Opus 4.8** and **requires 30-day data
retention** (zero-retention orgs get a 400 on every request). Also note its recommended
`xhigh` setting **isn't reachable on Claude Code** — chamba's `extreme` maps to `max`
there (it maps to `xhigh` only on the OpenAI path), so a Fable 5 role runs at `high` or
`max`, never `xhigh`.

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

If you already wrote a plan (in plan mode, exported to a `.md`, or by hand), reuse it and
skip the planning step:

```
/ticket -p ./plans/TICKET-123.md TICKET-123
```

`/ticket` runs the full orchestrator-worker flow: `chamba_load_context` → delegate the
plan to the **planner** subagent (or, with `-p <plan-path>`, read your plan and skip
this) → `chamba_review_plan` + the **reviewer** subagent → **ask you any open questions
the plan left unresolved**, fold in your answers → create worktrees only for the repos
the plan touches → delegate code to **implementer** and tests to **tester** (all inside
the worktrees) → verify the real diff (referential closure + build/typecheck) →
`chamba_summarize_to_vault`. It clarifies once up front, then runs to the end and stops
for your review with an acceptance-criteria checklist. It **never commits, merges or
pushes** — you review, commit and send to code review by hand. Each worker runs with the
model + effort you configured above.

> **Security:** `copyEnvFiles` copies secrets into the worktree directories. Add your
> `worktrees.root` (e.g. `WORKTREES/`) to `.gitignore` so they're never committed. It's
> off by default.

## Bootstrap the architecture map with `/map`

What makes `/ticket` precise is a vault that already describes how your repos fit
together. On a small or new project, seed that in one shot:

```
/map          # asks EN/ES, then maps every repo
/map es web   # Spanish notes, scoped to the `web` repo
```

`/map` resolves the vault (`chamba_vault_status` — run `/workspace init` first if you
don't have one), asks which language to write in, reads the repos for their cross-repo
wiring (REST, async/events, shared data, build deps), and writes **living notes** with
stable names: `Topology.md`, `Data flows.md`, `Domain entities.md`, and `repos/<repo>.md`.
Re-run it as the project grows — it updates its own notes in place and **never touches a
note you edited by hand** (it only rewrites notes marked `source: chamba`). It's opt-in;
on a big monorepo, mapping everything is expensive.

## Acceptance QA with the `qa` agent

For user-facing tickets, the **planner** adds a `## QA plan` to the plan (local seed, test
users, URLs, login steps) and writes each acceptance criterion as **Given/When/Then**
(Dado/Cuando/Entonces) — precondition, action, observable result — so it's unambiguous to
test. The heuristic reviewer (`chamba_review_plan`, no LLM) warns `qa-criteria-not-testable`
when a QA plan skips that structure. Then `/ticket` runs a final **acceptance-QA** phase:
the `qa` subagent validates each criterion against the **running app**, not the code. It **adapts to the project** — if the repo has
Playwright/Cypress (or a browser MCP) it drives the browser; otherwise it runs the repos
from the worktree, applies the local seed, and co-pilots with you, asking you to log in and
telling you what to click while you watch. It reports PASS/FAIL per criterion and never
commits.

Run it on its own to test or re-test without redoing the ticket:

```
/qa TICKET-123                    # locate the worktree, run the QA plan
/qa -p ./plans/T-123.md TICKET-123
```

Backend-only tickets get no QA phase.

**Enabling browser-driven QA (Claude Code).** Cursor has a built-in browser; Claude Code
doesn't, so add a Playwright MCP — at **user scope** so it leaves no trace in your repo.
In `~/.claude.json`:

```json
{ "mcpServers": { "playwright": { "command": "npx", "args": ["-y", "@playwright/mcp@latest"] } } }
```

Run `npx playwright install chromium` once — the browsers land in your **user cache**
(`~/.cache/ms-playwright`). Both the MCP and the browsers live outside the project;
nothing is added to your `package.json` or `node_modules`. chamba never bundles or runs a
browser itself — the `qa` agent uses whatever is available and co-pilots when nothing is.

## License

MIT
