# @chamba/claude-extras

Optional **Claude Code** extras for [chamba](https://github.com/thelord07/chamba):
slash commands, subagents and hooks on top of the chamba MCP server.

> Cursor, VS Code and other MCP editors don't need this — they get everything via
> the [`@chamba/mcp`](https://www.npmjs.com/package/@chamba/mcp) server. This package
> is Claude-Code-specific sugar.

## Usage

```bash
npx @chamba/claude-extras@latest install      # add commands, agents, hooks + register MCP
npx @chamba/claude-extras@latest install --global  # + npm i -g @chamba/mcp; launch the binary, not npx
npx @chamba/claude-extras@latest install --force   # overwrite existing files
npx @chamba/claude-extras uninstall    # remove them
npx @chamba/claude-extras rollback     # undo the last --force / uninstall
npx @chamba/claude-extras --version    # print the installed version
```

**`--global` — a more reliable launch.** By default the MCP server is registered as
`npx -y @chamba/mcp`, which re-resolves the package from npm on **every** spawn (each editor
start and reconnect). If npm is slow or a reconnect races, that spawn can fail and the editor
shows chamba as *disconnected*. `install --global` runs `npm i -g @chamba/mcp` (pinned to this
version) and registers `{ "command": "chamba-mcp" }` instead — no per-launch npm, much steadier.
If the global install can't run (permissions), it falls back to the npx launcher and tells you.

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

- **Slash commands**: `/ticket`, `/triage`, `/workspace`, `/map`, `/qa`, `/design`, `/worktrees`, `/orq`, `/recall`, `/vault`
- **Subagents**: `planner`, `implementer`, `reviewer`, `tester`, `qa`, `diagnostician`
- **Hooks**: warn on destructive commands, validate worktree edits

…and registers the `chamba` MCP server in `~/.claude.json`. It never overwrites your
existing files and preserves any other MCP servers.

Then, in Claude Code: `/orq add a health check endpoint`

## Troubleshooting: chamba shows as "disconnected"

chamba is a stdio MCP server — **your editor** spawns it and owns the connection; chamba can't
reconnect itself. If it shows disconnected (e.g. after a `/compact` triggers a reconnect):

1. In Claude Code, run **`/mcp`** → select `chamba` → **Reconnect**. If that doesn't take,
   **restart** the editor (it re-reads the MCP config and relaunches the server).
2. It's usually a transient `npx` spawn failure. Make it reliable: **`install --global`**
   (above) registers the `chamba-mcp` binary so no npm resolution happens on each launch.
3. Check the wiring with **`npx @chamba/mcp doctor`** — its **MCP registration** check warns when
   `chamba` is registered in more than one config (e.g. a global `~/.claude.json` *and* a project
   `.mcp.json`) with a different command or `CHAMBA_OBSIDIAN_VAULT_PATH`; the editor silently picks
   one, which may not be the one you meant. Keep a single entry (prefer the project one).

## Configuration: per-agent model + effort

chamba lets you pick which **model** and **effort** each **role** uses
(orchestrator, planner, reviewer, implementer, tester, qa, summarizer, researcher).

> **chamba never calls these models.** This config is declarative metadata. For
> Claude Code it's written into each subagent's frontmatter (`model:` + `effort:`)
> in `~/.claude/agents/*.md`; Claude Code is what runs the model. Other editors read
> the same config through the MCP tool `chamba_get_agent_config`. No API keys, ever.

### The recommended defaults (and why)

The philosophy: **critical reasoning gets powerful models, mechanical execution gets
fast/cheap ones.** These ship pre-configured — you only change what you want.

| Role | Default model | Effort | Why |
|---|---|---|---|
| **orchestrator** | `claude-opus-5` | high | The brain: decomposes, plans, decides. Near-Fable quality at Opus price. |
| **planner** | `claude-opus-5` | high | Planning delegated; Opus 5 at `high` — the token-savings sweet spot (bump to `quality` for `max`). |
| **reviewer** | `claude-opus-5` | high | Critical audit; deep reasoning on the strongest Opus. |
| **implementer** | `claude-sonnet-5` | medium | Executes clear specs; faster + cheaper (intro $2/$10) and stronger than 4.6. |
| **tester** | `claude-sonnet-5` | medium | Tests over already-implemented code; same profile. |
| **qa** | `claude-opus-5` | high | Acceptance QA: reasons about criteria and drives the running app. |
| **summarizer** | `claude-haiku-4-5` | low | Summaries are mechanical; a fast, cheap model is perfect. |
| **researcher** | `claude-opus-5` | high | Research + synthesis (also the `/triage` diagnostician). |

Since **Opus 5** matches Fable 5's quality at half the API price (and the same price as
Opus 4.8), it's the default for every reasoning role. **Sonnet 5** handles execution — at
intro pricing it's cheaper *and* stronger than Sonnet 4.6. The old Opus 4.8/4.7 and Sonnet
4.6 stay in the catalog if you want to pin them.

**Claude Fable 5** (`claude-fable-5`) is in the catalog as an **opt-in premium** model —
assign it to a role by hand; it's never a default (Opus 5 matches it for most work at half
the API price). chamba surfaces its caveats (wizard, config hint, subagent frontmatter):
API pay-as-you-go is **~2× Opus 5** and it **requires 30-day data retention** (zero-retention
orgs get a 400 on every request). On the **Claude Max plan** it's **included** — it counts
toward your weekly limit (up to 50% of it on Fable 5) and needs **Claude Code ≥ 2.1.170**.
Also note its recommended `xhigh` setting **isn't reachable on Claude Code** — chamba's
`extreme` maps to `max` there (it maps to `xhigh` only on the OpenAI path), so a Fable 5 role
runs at `high` or `max`, never `xhigh`.

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

## Read-only pre-diagnosis with `/triage`

`/triage` is the **front half of `/ticket` with the back half off**: it investigates and
proposes a fix, but **never touches code** — no worktrees, no edits, no commits. Use it for
support cases and bug reports, to write a **pre-diagnosis into the ticket**, or to check
whether the ticket even has enough info to work on.

```
/triage BUG-42            # investigate BUG-42, output a diagnosis to paste in
/triage BUG-42 api web    # focus the investigation on the api + web repos
```

It runs `chamba_load_context` → **`chamba_triage_ticket`** (a heuristic, **no-LLM**
completeness check that flags what the ticket is missing: reproduction, expected-vs-actual,
environment, scope, acceptance criteria, severity — with the exact questions to ask back) →
the **diagnostician** subagent, which investigates read-only and produces a root-cause
hypothesis with `file:line` evidence, the blast radius, a reproduction, a **proposed fix
plan (not executed)**, and a severity + confidence. If the fix plan is concrete it's checked
with `chamba_review_plan`.

The output is one **paste-ready markdown block** for the ticket. When you ask, `/triage`
saves the proposed fix with `chamba_save_plan`, so the handoff to execution is one command:

```
/ticket -p <the-saved-plan> BUG-42     # now actually implement the fix
```

`/triage` diagnoses and writes; `/ticket` executes. The heuristic + the diagnostician are
honest about hypotheses vs. confirmed causes, and — like every chamba agent — nothing is
deleted or run without you.

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

**Mobile QA (React Native / Expo).** Same pattern, one rung down. `chamba_workspace_init`
detects a mobile app (Expo managed/bare, EAS, dev-client, E2E tooling) into a `## Mobile`
section, and the `qa` agent calls **`chamba_qa_capabilities`** — a read-only probe (no LLM)
that reports web vs mobile and enumerates the **iOS simulators / Android emulators actually
available** on the machine (`xcrun simctl` / `adb` / `emulator -list-avds` — it lists, never
boots). Then the `qa` agent picks its mode: if an **Expo/mobile MCP** is configured it drives
a simulator/emulator through it; if only a simulator/emulator is available it co-pilots via
`expo start`; if neither, it co-pilots on your physical device via **Expo Go**. chamba never
boots a device or runs Expo — your editor's mobile MCP or the terminal does. Login stays
human, as everywhere in QA. To drive devices automatically, add an Expo or device-control MCP
(e.g. `mobile-mcp`) at user scope, same as the Playwright MCP above.

## Design-aware tickets (Figma, mockups, prototypes)

Same pattern as QA: **detect → use if present → degrade**. For a visual ticket, the **planner**
adds a `## Design` section. The **implementer** pulls exact tokens/measurements from a **Figma
MCP** if one is configured, otherwise builds from the mockups/specs; the **qa** agent adds a
**visual check** against the reference. The heuristic reviewer warns `missing-design-capture`
when a plan links Figma but never captures the design. chamba never calls Figma — your editor's
Figma MCP does; it's honest about being **design-accurate**, not "pixel-perfect".

### Linking a design source

Instead of pasting a Figma link into every ticket, **link the source once** and chamba resolves
it per ticket. A design source is a pointer in `.chamba/design/<name>.md` that links an
**external** location — kept out of the repo so mockups/binaries never bloat it:

```markdown
---
name: checkout-redesign
description: New checkout flow — 3 screens
figma: https://figma.com/file/abc        # any of these that apply
folder: ~/Designs/checkout               # external folder of mockups + specs
prototype: ~/Designs/checkout/app.html   # a standalone .html or .zip to open/run
---
The prompt your design tool gave you; key screens, states, breakpoints, tokens.
```

Link one fast with **`/design link checkout ~/Designs/checkout`** (a folder, a `.html`/`.zip`
prototype, or a Figma URL — it detects which). Then `chamba_load_design` returns the brief, the
Figma link, and the asset paths (mockups for the editor to open, the standalone prototype to
run, specs inline). The **standalone/`.zip`** export (e.g. from Claude Code) is the best
reference — the implementer and qa **open it** as the behavioural target.

### UI architecture — asked once, reused

The first visual ticket, the planner **asks which methodology** to build in (Atomic Design,
Feature-Sliced, component-driven, or — for Expo/React Native — screens+components) and **saves
it** with `chamba_design_prefs`. Web and mobile are stored separately (in
`.chamba/design/conventions.json`), so an Expo app can use a different architecture than the web
app. After that it's reused silently; change it with `/design prefs web=atomic mobile=screens`.

## Skills / playbooks

Reusable conventions and playbooks live in `.chamba/skills/*.md`, each with frontmatter:

```markdown
---
name: knex-multitenant
description: Multi-tenant Knex queries — always filter by tenant_id
scope: backend
---
The playbook body: steps, conventions, gotchas, examples.
```

At the start of a task, `/ticket` and `/orq` call **`chamba_load_skills`**, which matches the
task against each skill's `description` (index-first, **no LLM**) and returns the relevant ones
**with their body** plus the full catalog — so the model reads a cheap index and only pulls the
playbooks that apply. It ships **empty and opt-in**: you and your team fill `.chamba/skills/`
over time (project scope), and personal playbooks can live in `~/.chamba/skills/` (a project
skill of the same name wins).

## License

MIT
