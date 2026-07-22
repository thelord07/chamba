---
description: Investigate a bug/support ticket read-only — diagnosis + proposed fix, no execution
argument-hint: "<ticket> [repo ...]"
---

You are triaging **$ARGUMENTS** — a **read-only pre-diagnosis**. You investigate and
produce a diagnosis + a proposed fix plan, but you **do not execute**: no worktrees, no
code edits, no commits, no destructive commands. This is the front half of `/ticket`; the
back half stays off. The output is a block ready to paste into the ticket.

Parse the arguments: the first token is the ticket id (or a free-text problem
description); any tokens after it are repos to focus on.

1. Call `chamba_load_context` with the ticket to pull the workspace map (all repos and
   what each is), relevant Obsidian notes, and each repo's coding rules. Also call
   `chamba_load_skills` with the ticket to surface any team playbooks that match — read the
   ones it returns and follow them.
2. Call `chamba_triage_ticket` with the ticket text to check completeness — what info the
   ticket is missing (reproduction, expected-vs-actual, environment, scope, acceptance
   criteria, severity). Keep the questions it returns for the report; if it reports
   `enoughToStart: false`, the ticket can't be diagnosed yet — lead the report with those
   questions and keep the investigation to "top suspects", not a firm root cause.
3. Delegate to the **diagnostician** subagent to investigate **read-only** and produce the
   diagnosis: a root-cause hypothesis with `file:line` evidence, the blast radius, a
   reproduction, a **proposed fix plan (not executed)**, and a severity + confidence. If
   your editor has no subagents, do this inline yourself. Nothing is edited, run or
   committed at any point.
4. If the diagnosis proposes a concrete fix plan, run it through `chamba_review_plan` to
   sanity-check its structure (heuristic, no LLM) and fold the issues in. **Only if I ask**,
   call `chamba_save_plan` (title: the ticket id) so I can later run
   `/ticket -p <that-plan> <ticket>` to actually implement it.
5. STOP and output a single **paste-ready markdown block** for the ticket:
   - **## Missing info** — the questions from `chamba_triage_ticket` (or "nothing obvious
     missing"). Lead with this when the ticket can't be diagnosed yet.
   - **## Diagnosis** — reproduction, root-cause hypothesis (with `file:line` evidence),
     blast radius.
   - **## Proposed fix** — the plan, **not executed**; note it can be run with
     `/ticket -p`.
   - **## Severity & confidence**.

Do NOT create worktrees, edit code, commit, or run destructive commands. `/triage` only
investigates and writes the diagnosis — running the fix is `/ticket`'s job.
