---
description: Run acceptance QA for a ticket — validate its acceptance criteria against the running app
argument-hint: "[-p <plan-path>] <ticket> [repo ...]"
---

Run acceptance QA for ticket **$ARGUMENTS** — standalone, to test or re-test a
ticket without re-running the whole `/ticket` flow.

Parse the arguments: if they start with `-p`/`--plan`, the next token is a plan
file to read the `## QA plan` and acceptance criteria from. The first non-flag token
is the ticket id; any remaining tokens are repos to scope to.

**Orchestration capability.** The steps below delegate to subagents. Use the richest
orchestration your editor supports, and degrade cleanly: with **parallel subagents**,
fan out independent checks and reconcile them; with **one subagent at a time**, run
them sequentially; with **no subagents**, do the work inline yourself. Never assume a
specific editor primitive — adapt to what you have.

1. Locate the code under test: call `chamba_list_worktrees` and use the worktree for
   this ticket if one exists; otherwise use the current checkout. All QA runs there.
2. Get the acceptance criteria and QA setup:
   - from the `-p` plan file if given (its `## QA plan` + acceptance criteria); else
   - `chamba_load_context` for the ticket and infer the acceptance criteria from the
     ticket + workspace. If you still can't tell what to verify, ask me for the
     ticket text before going further.
3. Delegate to the **qa** subagent to run it: it detects the project's tooling
   (Playwright/Cypress/browser MCP, how to run the app, the seed mechanism), sets up
   the local seed and test users, runs the app, asks me to log in when needed, and
   walks each acceptance criterion against the running app.
4. Report **PASS/FAIL per acceptance criterion** with the evidence. Everything is
   local and non-destructive — do NOT commit, push, or touch production.
