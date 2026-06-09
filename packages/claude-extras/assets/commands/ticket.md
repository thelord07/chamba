---
description: Resolve a ticket end-to-end in isolated worktrees, delegating to chamba's agents
argument-hint: <ticket> [repo ...]
---

You are orchestrating ticket **$ARGUMENTS** end-to-end. chamba provides the
worktrees, context, plan validation and vault memory; you delegate the thinking
and the code to the configured subagents. **Run to the end and stop only for my
final review** — do not pause for approval mid-way.

1. Create isolated worktrees: call `chamba_create_worktrees` with the ticket id
   (and the repos if I named any). ALL work happens INSIDE these worktrees —
   never edit the main checkouts. Note the branch and per-repo worktree paths.
2. Call `chamba_load_context` with the ticket to pull the workspace map + relevant
   Obsidian notes.
3. Delegate to the **planner** subagent to produce the detailed plan. Run it
   through `chamba_review_plan`; if not approved, fix and re-review (max 3 rounds).
   Also have the **reviewer** subagent audit it. Do all of this WITHOUT stopping to
   ask me — the heuristic review + the reviewer agent are the quality gate.
4. For each subtask/repo, delegate implementation to the **implementer** subagent,
   working only in that repo's worktree. Delegate the tests to the **tester**
   subagent and run them.
5. Call `chamba_summarize_to_vault` with a summary of what changed.
6. STOP and report for my review: per repo, what changed and the test results; the
   `.code-workspace` to open; and the suggested commit + `git merge --no-ff`
   commands. Do NOT commit, merge or push — I review, commit and send to my
   company's code review by hand.
