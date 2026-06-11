---
description: Resolve a ticket end-to-end in isolated worktrees, delegating to chamba's agents
argument-hint: "[-p <plan-path>] <ticket> [repo ...]"
---

You are orchestrating ticket **$ARGUMENTS** end-to-end. chamba provides context,
plan validation, worktrees and vault memory; you delegate the thinking and the
code to the configured subagents. **Run to the end and stop only for my final
review** — do not pause for approval mid-way.

**One exception to running autonomously:** the plan itself may mark an item as
needing my approval (scope expansion beyond the ticket, a destructive or
irreversible change, a product decision you can't make). You do NOT act on those.
You complete everything else and surface them at the final gate. Autonomy is
bounded by the plan's gates — it must never silently drop an acceptance criterion.

Parse the arguments first. If they start with `-p` or `--plan`, the next token is
the path to a plan I already wrote (relative to the workspace root, or absolute) —
read it and skip planning (see step 2). The first non-flag token is the ticket id;
any tokens after it are repos I named explicitly. Analyze first, create worktrees
only for the repos actually touched — do not create a worktree for every repo in
the workspace.

1. Call `chamba_load_context` with the ticket to pull the workspace map (all repos
   and what each one is) + relevant Obsidian notes + each repo's coding rules.
2. Obtain the plan:
   - **If I passed `-p <plan-path>` and the file exists:** read it and use it as
     THE plan — do NOT delegate to the planner. Run it through `chamba_review_plan`
     to sanity-check structure and surface issues, but do NOT bring in the reviewer
     subagent to rewrite it (I already approved this plan). If the plan doesn't
     cover a ticket acceptance criterion, or fails to mark a risky item
     **needs-approval**, note it as a gap and carry it to the final report — don't
     invent scope to fill it. Then skip to step 4.
   - **If `-p` was given but the file does not exist:** tell me you couldn't find
     it, then fall back to generating the plan (next bullet).
   - **Otherwise (no `-p`):** delegate to the **planner** subagent to produce the
     plan, then continue to step 3.
   Either way the plan MUST state **which repos the ticket touches and why**, with
   subtasks grouped per repo, and map **every acceptance criterion of the ticket**
   to a subtask. Items needing a decision you can't make autonomously are marked
   **needs-approval** — a hard gate, not something to resolve on your own. If I
   named repos in the arguments, use exactly those; otherwise infer the set from
   the plan + the workspace map. List ambiguities as assumptions — do not invent
   scope.
3. (Skip when the plan came from `-p` — already checked in step 2.) Run the plan
   through `chamba_review_plan` and have the **reviewer** subagent audit it. Fix
   and re-review until approved (max 3 rounds). Do NOT stop to ask me.
4. Create isolated worktrees ONLY for the repos the plan identified: call
   `chamba_create_worktrees` with the ticket and that repo list. ALL work happens
   inside these worktrees — never edit the main checkouts.
5. For each subtask/repo, delegate implementation to the **implementer** subagent
   (in that repo's worktree) and the tests to the **tester** subagent; run them.
6. **Verify against the real diff** (not the plan). For each touched repo: have the
   **reviewer** subagent audit the actual diff for correctness, missing tests, and
   **referential closure** — anything the change deleted must leave no orphaned
   callers and no now-unused exports. Then run that repo's build / typecheck / lint,
   and a dead-code check if the repo has one (knip, ts-prune). Token grep alone
   misses orphans whose name doesn't contain the deleted symbol — rely on the
   build/typechecker/dead-code tool, not just grep. Fix what comes back, then
   re-verify (max 3 rounds).
7. Call `chamba_summarize_to_vault` with a summary of what changed.
8. STOP and report for my review. The report MUST include:
   - the repos touched and why;
   - per repo, what changed and the test + verify results;
   - an **acceptance-criteria checklist**: every AC of the ticket marked
     **Delivered** or **Not delivered**. Anything the plan marked
     **needs-approval**, or any AC you could not deliver without a deferred
     decision, goes under **"Needs your decision"** with what's pending and why —
     never omit it;
   - the `.code-workspace` to open, and the suggested commit +
     `git merge --no-ff` commands.
   Do NOT commit, merge or push — I review, commit and send to my company's code
   review by hand.
