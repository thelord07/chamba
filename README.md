<p align="center">
  <img src="./docs/chambalogo2.png" alt="chamba — your CLI to ship projects" width="340" />
</p>

# chamba

[![npm](https://img.shields.io/npm/v/@chamba/mcp.svg)](https://www.npmjs.com/package/@chamba/mcp)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-7c3aed.svg)](https://modelcontextprotocol.io)

> **An MCP server that adds orchestrator-worker patterns, workspace context, git
> worktrees and Obsidian memory to any AI editor** — Cursor, Claude Code, VS Code
> (Copilot), Windsurf, Cline, OpenCode, Zed, JetBrains, Gemini CLI, Codex, Trae, Kiro.
> No API key: your editor's model does the
> reasoning, chamba does the coordination.

*"Chamba"* is the LATAM word for *work* — *la chamba*. You hand the model its chamba;
chamba (the tool) handles the supervising, validating and plumbing around it.

📖 [Español](./README.es.md) · 🧩 [Editor setup guides](./examples/) · 🗺️ [Roadmap](#roadmap)

> 🎉 **v0.11.1 is live on npm** — `npx @chamba/mcp`. Built in public, phase by phase
> ([`PLAN.md`](./PLAN.md)). Pre-1.0: usable today, still evolving.

## Demo

> 🎥 A GIF of `/orq` running in Cursor goes here. Until then, the
> [editor setup guides](./examples/) are runnable step-by-step walkthroughs.

## Why chamba

- **Zero API keys.** No `ANTHROPIC_API_KEY`, no `OPENAI_API_KEY`. Your editor already
  pays for its own model; chamba never calls an LLM.
- **Every MCP editor, day one.** One stdio server works in Cursor, Claude Code, VS
  Code, Windsurf, Cline, OpenCode, Zed, JetBrains, Gemini CLI, Codex, Trae and Kiro.
- **Workspace-aware.** It scans your project into an editable `.chamba/workspace.md`
  and feeds that context to plans.
- **Plan + heuristic review.** A programmatic reviewer (no LLM) flags missing tests,
  unassigned work, sensitive areas without a risk assessment, and more.
- **Safe parallelism.** Git worktrees isolate parallel work; cleanup keeps branches
  for you to merge by hand — never `--force`, never auto-merge.
- **Obsidian + cross-session memory.** Pull context from your vault, write summaries
  back, and persist knowledge as plain markdown. Notes are grouped per project (by git
  remote) and each folder keeps a lightweight `INDEX.md`, so recall scans a cheap index
  instead of reading every note.
- **Safe by default.** No chamba agent deletes or destroys anything on its own — a DB
  drop/reset/truncate, deleting files or data, a force-push or a branch delete all stop
  and ask for your explicit confirmation first (a Claude Code hook enforces it too).
- **Resource-aware parallelism.** Before a multi-repo `/ticket` fans out workers, chamba
  sizes safe concurrency from the machine's RAM/CPU (no LLM) — so a big ticket runs in
  waves instead of thrashing an 8/16 GB laptop. Cap it with `worktrees.maxParallel`.

## Use chamba from your editor

Each editor has a one-file config. Full walkthroughs in [`examples/`](./examples/).

**Cursor** — `.cursor/mcp.json` ([guide](./examples/cursor-setup)):

```json
{ "mcpServers": { "chamba": { "command": "npx", "args": ["-y", "@chamba/mcp"] } } }
```

**Claude Code** ([guide](./examples/claude-code-setup)):

```bash
claude mcp add chamba -- npx -y @chamba/mcp
```

**VS Code / Copilot** — `.vscode/mcp.json` ([guide](./examples/vscode-setup)).
Note: VS Code uses **`"servers"`**, not `"mcpServers"`:

```json
{ "servers": { "chamba": { "type": "stdio", "command": "npx", "args": ["-y", "@chamba/mcp"] } } }
```

**Windsurf** — `~/.codeium/windsurf/mcp_config.json` ([guide](./examples/windsurf-setup)) ·
**OpenCode** — `opencode.json` ([guide](./examples/opencode-setup)).

**More editors** — [Gemini CLI](./examples/gemini-cli-setup) · [Codex](./examples/codex-setup) (TOML) ·
[JetBrains](./examples/jetbrains-setup) · [Trae](./examples/trae-setup) ·
[Zed](./examples/zed-setup) (`context_servers`) · [Kiro](./examples/kiro-setup).

To wire up an Obsidian vault, add `"env": { "CHAMBA_OBSIDIAN_VAULT_PATH": "/path/to/vault" }`.
Don't have one? `chamba_workspace_init` bootstraps a **global vault outside your repos**
(`~/.chamba/vault`, autodetected) and seeds a "Workspace overview" note when it can't find one —
so memory works from day one without polluting the repo.

Not sure everything's wired? Run `npx @chamba/mcp doctor` (or the `chamba_doctor` tool from
your editor) for a pass/warn/fail health check of Node, git, the workspace, config, the vault,
the log directory and worktrees.

## Tools

| Tool | Input | Output |
|---|---|---|
| `chamba_workspace_init` | `{ root?, createVault? }` | Scans and writes `.chamba/workspace.md` (won't overwrite); detects the auth stack (Auth0/Firebase/Cognito/…) into an `## Auth` section; bootstraps a **global vault outside your repos** (`~/.chamba/vault`) if none is found, and gitignores a vault that lives inside a repo |
| `chamba_workspace_show` | `{}` | Contents of `.chamba/workspace.md` |
| `chamba_workspace_reload` | `{}` | A diff vs a fresh re-scan (no writes) |
| `chamba_load_context` | `{ task, includeObsidian? }` | Workspace summary + relevant vault notes |
| `chamba_load_skills` | `{ task, max? }` | Relevant team playbooks from `.chamba/skills/*.md` (index-first, no LLM) + the full catalog. Ships empty, opt-in |
| `chamba_load_design` | `{ task, max? }` | Resolves the linked design source for a ticket (no LLM): a Figma URL, a folder of mockups/specs, or a standalone `.html`/`.zip` prototype declared in `.chamba/design/*.md` — returns the brief + asset paths + the saved UI-architecture preference |
| `chamba_design_prefs` | `{ web?, mobile? }` | Get/set the UI-architecture preference (Atomic Design, Feature-Sliced, …) so the planner asks once and reuses it. Web and mobile separate. No LLM |
| `chamba_summarize_to_vault` | `{ title, content, projectSlug? }` | Writes a run summary to `proyectos/` — grouped per project (git remote) + a per-folder `INDEX.md` for cheap recall |
| `chamba_save_plan` | `{ title, content, projectSlug? }` | Saves a plan to `plans/` — same per-project grouping + index |
| `chamba_vault_status` | `{}` | Resolved vault path + the notes chamba can see (diagnostic) |
| `chamba_doctor` | `{}` | Environment health check (no LLM): Node, system (RAM/CPU), git (multi-repo aware), workspace, config, vault, MCP registration (warns on duplicate/inconsistent chamba entries), logs, worktrees → pass/warn/fail. Also `npx @chamba/mcp doctor` |
| `chamba_resource_budget` | `{ requested?, perWorkerMemMB? }` | Safe parallelism for **this** machine (no LLM): reads live RAM/CPU/load → how many worktrees/workers to run at once. Consult it before a multi-repo fan-out |
| `chamba_qa_capabilities` | `{}` | What acceptance QA can run against (no LLM): web vs mobile (React Native / Expo), E2E tooling, and the iOS simulators / Android emulators actually available (read-only `xcrun simctl` / `adb` / `emulator` — lists, never boots). The qa agent picks its mode from this |
| `chamba_triage_ticket` | `{ ticket }` | Heuristic completeness check for a support/bug ticket (no LLM): `{ present, missing, questions, enoughToStart, score }` — flags whether it has reproduction, expected-vs-actual, environment, scope, acceptance criteria, severity, with the questions to ask back. Powers `/triage` |
| `chamba_generate_plan` | `{ task, context? }` | A structured plan template to fill |
| `chamba_review_plan` | `{ plan, task, context? }` | `{ approved, issues, suggestions, riskFlags }` — no LLM |
| `chamba_create_worktree` | `{ taskSlug, workerId, baseBranch? }` | An isolated git worktree |
| `chamba_list_worktrees` | `{}` | The repo's worktrees |
| `chamba_cleanup_worktree` | `{ branch }` | Removes the dir, **keeps the branch** |
| `chamba_remember` | `{ key, content, tags? }` | Persists a markdown memory |
| `chamba_recall` | `{ query }` | Searches saved memories |
| `chamba_get_agent_config` | `{ role }` | `{ model, effort, reasoning_priority, provider, hint }` for a role — no LLM |
| `chamba_create_worktrees` | `{ ticket, repos? }` | Multi-repo worktrees for a ticket (config-driven); keeps branches |
| `chamba_cleanup_worktrees` | `{ ticket, repos? }` | Removes a ticket's worktrees, **keeps every branch** |

## How it works

chamba provides tools and patterns; your editor's model provides the reasoning.

```
You (in Cursor):  "@chamba orchestrate: add a health check endpoint"
        │
        ▼
Editor's model reasons, then calls chamba tools:
        │
        ├─▶ chamba_load_context   →  workspace map + relevant Obsidian notes
        ├─▶ chamba_generate_plan  →  plan skeleton the model fills in
        ├─▶ chamba_review_plan    →  heuristic verdict (no LLM); model fixes issues
        ├─▶ chamba_create_worktree→  isolated branch per worker (if git)
        │       … model writes code & tests in the worktree …
        └─▶ chamba_summarize_to_vault → structured note back to Obsidian
        │
        ▼
Result in your editor's chat. Branches stay open for you to review & merge.
```

**chamba contributes:** workspace context, plan validation, worktree isolation,
vault memory. **The model contributes:** reasoning, decisions, code.

## Editor extras (optional)

Every MCP editor gets the tools. On **Claude Code**, **Cursor** and **OpenCode** you can
also install the slash commands and subagents (same prompts, one source):

```bash
npx @chamba/cursor-extras@latest install     # Cursor:   /ticket, /triage, /qa … + subagents + MCP
npx @chamba/opencode-extras@latest install   # OpenCode: /ticket, /triage, /qa … + subagents + MCP
```

On **Claude Code** you additionally get hooks:

```bash
npx @chamba/claude-extras@latest install     # /ticket, /triage, /workspace, /map, /qa, /design … +
                                      # planner/implementer/reviewer/tester/qa/diagnostician agents + 2 hooks
npx @chamba/claude-extras uninstall
```

Idempotent, never overwrites your files (`--force` to force), preserves other MCP
servers in `~/.claude.json`. `--force` and `uninstall` snapshot the current state first,
so `npx @chamba/claude-extras rollback` can undo them. Add `--global` to install
`@chamba/mcp` globally and launch the `chamba-mcp` binary instead of `npx` — a steadier
connection that won't drop on a flaky spawn. Then: `/orq add a health check endpoint`.

**Per-agent config.** First install runs a wizard to pick a model + effort per role
(orchestrator, planner, reviewer, implementer, tester, qa, summarizer, researcher), with
efficient defaults pre-set and tuned for token savings: **Opus 5** for the reasoning roles
(Fable-grade quality at half the API price, same price as Opus 4.8) and **Sonnet 5** for
execution (intro $2/$10 through Aug 2026). **Fable 5** stays opt-in — and it's included on
the Claude Max plan (up to 50% of the weekly limit, Claude Code ≥ 2.1.170). Reconfigure with
`npx @chamba/claude-extras config <show|set|wizard|…>`, or flip the whole cost/quality dial
at once with `config preset <budget|balanced|quality|fast>`.
chamba still never calls a model: this only tells your editor's model how to delegate.
Other editors read the same config via `chamba_get_agent_config`. See the
[claude-extras README](./packages/claude-extras/README.md#configuration-per-agent-model--effort).

**Read-only triage before you commit to a fix.** `/triage BUG-42` is the front half of
`/ticket` with the back half off: it investigates and proposes a fix but **never touches
code** — no worktrees, edits or commits. It runs a heuristic, no-LLM completeness check
(`chamba_triage_ticket`) that flags what the ticket is missing — reproduction,
expected-vs-actual, environment, scope, acceptance criteria, severity — with the exact
questions to ask back, then the `diagnostician` agent investigates and returns a
root-cause hypothesis (with `file:line` evidence), blast radius, a reproduction, and a
**proposed fix plan** as one paste-ready block for the ticket. When you're ready, it hands
the saved plan to `/ticket -p` to execute. Perfect for support cases and pre-diagnosis.

**Acceptance QA, as a co-pilot.** When a ticket is user-facing, the `qa` agent validates
the acceptance criteria against the *running* app — driving a real browser if the repo
has Playwright/Cypress (or a browser MCP), otherwise running the app from the worktree
and co-piloting with you. For **React Native / Expo** apps it runs on a **simulator or
emulator** (via your editor's Expo/mobile MCP, or `expo start` co-piloted, or Expo Go on
your device) — `chamba_qa_capabilities` reports what this machine has. Every login is your
step; it reuses the users/roles that already exist instead of creating throwaway accounts,
seeds only additively, and captures a numbered screenshot per criterion (PASS and FAIL)
into a per-run evidence folder kept outside every git repo. Run it inside `/ticket` or on
its own with `/qa`.

**Design-aware for visual tickets.** Link your design once — `/design link checkout
~/Designs/checkout` writes a `.chamba/design/*.md` pointer to an **external** folder of
mockups, a Figma URL, or the standalone `.html`/`.zip` prototype your design tool exports
(kept out of the repo). Then `chamba_load_design` resolves it per ticket: the planner captures
it in a `## Design` section, the implementer builds to the Figma tokens (if a **Figma MCP** is
configured) or the mockups/prototype, and the qa agent does a **visual check** against the same
reference. The first visual ticket, the planner **asks which UI architecture** you want (Atomic
Design, Feature-Sliced, …) and **saves it** (`chamba_design_prefs`, web + mobile separately) — it
reuses that silently after. chamba never calls Figma or runs the prototype — your editor's MCP /
browser does — and it's honest about *design-accurate*, not "pixel-perfect".

## Packages

| Package | What it is |
|---|---|
| `@chamba/mcp` | **The product.** A stdio MCP server exposing chamba's tools |
| `@chamba/core` | Pure logic (workspace, plan, worktree, obsidian, memory). No Node APIs directly |
| `@chamba/adapters` | Node implementations of the ports (filesystem, process, clock) |
| `@chamba/claude-extras` | Optional Claude Code installer (commands, subagents, hooks) |
| `@chamba/opencode-extras` | Optional OpenCode installer (the same commands + subagents) |
| `@chamba/cursor-extras` | Optional Cursor installer (the same commands + subagents) |

## How chamba compares

| | chamba | Claude Code subagents | A plain filesystem MCP |
|---|---|---|---|
| Works in any MCP editor | ✅ | ❌ (Claude Code only) | ✅ |
| Needs its own API key | ❌ | ❌ | ❌ |
| Plan + heuristic review | ✅ | ⚠️ ad-hoc | ❌ |
| Git worktree isolation | ✅ | ❌ | ❌ |
| Obsidian context + write-back | ✅ | ❌ | ❌ |
| Cross-session memory | ✅ | ⚠️ via files | ⚠️ raw files |

## Roadmap

- ✅ MCP server + workspace scanner
- ✅ Obsidian context + vault writer
- ✅ Plan generator + heuristic reviewer
- ✅ Git worktree manager
- ✅ Cross-session memory
- ✅ Claude Code extras
- ✅ Multi-editor docs (you're reading them)
- ✅ **0.1.0 published on npm**
- ✅ Per-agent model + effort config (wizard + `chamba_get_agent_config`)
- ✅ Multi-repo worktrees + `/ticket` flow (config-driven, env copy, `.code-workspace`)
- ✅ Acceptance-QA co-pilot (`/qa` + `qa` agent): validates criteria on the running app, screenshot evidence, login always human
- ✅ Auth-stack detection (`## Auth`) + delete-guard (no agent wipes data without asking)
- ✅ Resource-aware parallelism (`chamba_resource_budget`, RAM/CPU aware) + multi-repo-aware `chamba_doctor`
- ✅ Installer backup/rollback (`chamba-install rollback`) + Given/When/Then acceptance
- ✅ Design-aware tickets (Figma `## Design` → MCP tokens or screenshots)
- ✅ Skills/playbooks registry (`chamba_load_skills`, index-first, opt-in)
- ✅ Mobile QA for React Native / Expo (`chamba_qa_capabilities` → simulators/emulators)
- ✅ More editors: Zed, JetBrains, Gemini CLI, Codex, Trae, Kiro (setup guides + rule detection)
- ✅ Linkable design sources (`chamba_load_design`) + UI-architecture preference (`chamba_design_prefs`, `/design`)
- ✅ Release quality: golden reviewer tests, `doctor` CI gate, `--yes` installs, `RELEASING.md`
- ✅ Repo-safe vault: bootstrap outside repos (`~/.chamba/vault`), gitignore backstop, `doctor` warning
- ✅ **0.20.0 published on npm**
- ✅ Read-only `/triage`: pre-diagnosis + fix plan without executing (`chamba_triage_ticket` completeness check, `diagnostician` agent)
- ✅ **0.21.0 published on npm**
- ✅ **1.0.0 — first stable:** real MCP handshake version, 24-tool surface + docs polish, first stable tag
- ✅ **1.1.0 — Opus 5 + Sonnet 5:** new default reparto (Opus 5 reasoning at ½ Fable's price, Sonnet 5 execution), token-savings tuning, Fable-on-Max caveat
- ✅ **1.2.0 — reliable connection:** `install --global` (launch the `chamba-mcp` binary, no npx per spawn) + a `doctor` MCP-registration check (warns on duplicate/inconsistent entries)
- ✅ **1.3.0 — OpenCode extras:** `@chamba/opencode-extras` installs the same slash commands + subagents into OpenCode (translated to its format) and registers the MCP server
- ✅ **1.4.0 — Cursor extras:** `@chamba/cursor-extras` installs the same commands + subagents into Cursor (`.cursor/commands` + `.cursor/agents`, model from your reparto) and registers the MCP server
- 🔭 V2: semantic vault search, MCP sampling, more knowledge bases

See [`PLAN.md`](./PLAN.md) for the full phase plan.

## Requirements

- Node 22 LTS
- pnpm 9+ (for development)
- An editor with an MCP client (to use the tools)

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
pnpm biome check .
```

> MCP author note: a stdio server must never write to stdout except the protocol.
> chamba logs to `~/.chamba/logs/mcp-{pid}.log` via pino — never `console.log`.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). Issues and PRs welcome.

## License

MIT — see [`LICENSE`](./LICENSE). Built with cariño in Colombia.
