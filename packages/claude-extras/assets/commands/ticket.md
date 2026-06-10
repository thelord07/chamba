---
description: Resolve a ticket end-to-end in isolated worktrees, delegating to chamba's agents
argument-hint: <ticket> [repo ...]
---

You are orchestrating ticket **$ARGUMENTS** end-to-end. chamba provides context,
plan validation, worktrees and vault memory; you delegate the thinking and the
code to the configured subagents. **Run to the end and stop only for my final
review** — do not pause for approval mid-way.

The first token of the arguments is the ticket id; any further tokens are repos I
named explicitly. Analyze first, create worktrees only for the repos actually
touched — do not create a worktree for every repo in the workspace.

1. Call `chamba_load_context` with the ticket to pull the workspace map (all repos
   and what each one is) + relevant Obsidian notes.
2. Delegate to the **planner** subagent to produce the plan. The plan MUST state
   **which repos the ticket touches and why**, with subtasks grouped per repo. If I
   named repos in the arguments, use exactly those; otherwise infer the set from the
   ticket + the workspace map. If anything is ambiguous, list it as an assumption —
   do not invent scope.
3. Run the plan through `chamba_review_plan` and have the **reviewer** subagent
   audit it. Fix and re-review until approved (max 3 rounds). Do NOT stop to ask me.
4. Create isolated worktrees ONLY for the repos the plan identified: call
   `chamba_create_worktrees` with the ticket and that repo list. ALL work happens
   inside these worktrees — never edit the main checkouts.
5. For each subtask/repo, delegate implementation to the **implementer** subagent
   (in that repo's worktree) and the tests to the **tester** subagent; run them.
6. Call `chamba_summarize_to_vault` with a summary of what changed.
7. STOP and report for my review: the repos touched and why; per repo, what changed
   and the test results; the `.code-workspace` to open; and the suggested commit +
   `git merge --no-ff` commands. Do NOT commit, merge or push — I review, commit and
   send to my company's code review by hand.
