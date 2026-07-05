---
description: Resolve a ticket end-to-end in isolated worktrees, delegating to chamba's agents
argument-hint: "[-p <plan-path>] <ticket> [repo ...]"
---

You are orchestrating ticket **$ARGUMENTS** end-to-end. chamba provides context,
plan validation, worktrees and vault memory; you delegate the thinking and the
code to the configured subagents.

**Clarify once, up front; then run to the end.** There is exactly one point where
you may pause: once the plan is ready, if it has unresolved open questions or
decisions only I can make, ask me, fold my answers into the plan, and continue.
After that, run to the end and stop only for my final review — do not pause again
mid-way. You never resolve a flagged decision on your own and never silently drop
an acceptance criterion.

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
     invent scope to fill it. Then continue to the clarification gate (step 4).
   - **If `-p` was given but the file does not exist:** tell me you couldn't find
     it, then fall back to generating the plan (next bullet).
   - **Otherwise (no `-p`):** delegate to the **planner** subagent to produce the
     plan, then continue to step 3.
   Either way the plan MUST state **which repos the ticket touches and why**, with
   subtasks grouped per repo, and map **every acceptance criterion of the ticket**
   to a subtask. Items needing a decision you can't make autonomously are marked
   **needs-approval** — a hard gate, not something to resolve on your own. If I
   named repos in the arguments, use exactly those; otherwise infer the set from
   the plan + the workspace map. State confident assumptions as assumptions and put
   genuine forks under **Open questions** — do not invent scope.
3. (Skip when the plan came from `-p` — already checked in step 2.) Run the plan
   through `chamba_review_plan` and have the **reviewer** subagent audit it. Fix
   and re-review until approved (max 3 rounds). Do NOT stop to ask me.
4. **Clarification gate.** Before creating any worktree, check the plan for
   unresolved **Open questions** and any item marked **needs-approval**;
   `chamba_review_plan` flags these as `unresolved-open-questions`. If there are
   any: ask me all of them in one concise batch, wait for my answers, fold them
   into the plan (adjust scope, subtasks and acceptance criteria as needed), and
   only then continue. If the plan has none, proceed without pausing. This is the
   only place you stop before the final review — it applies whether the plan came
   from the planner or from `-p`.
5. Create isolated worktrees ONLY for the repos the plan identified: call
   `chamba_create_worktrees` with the ticket and that repo list. ALL work happens
   inside these worktrees — never edit the main checkouts.
6. For each subtask/repo, delegate implementation to the **implementer** subagent
   (in that repo's worktree) and the tests to the **tester** subagent; run them.
7. **Verify against the real diff** (not the plan). For each touched repo: have the
   **reviewer** subagent audit the actual diff for correctness, missing tests, and
   **referential closure** — anything the change deleted must leave no orphaned
   callers and no now-unused exports. Then run that repo's build / typecheck / lint,
   and a dead-code check if the repo has one (knip, ts-prune). Token grep alone
   misses orphans whose name doesn't contain the deleted symbol — rely on the
   build/typechecker/dead-code tool, not just grep. Fix what comes back, then
   re-verify (max 3 rounds).
8. **Acceptance QA** — only if the plan has a `## QA plan`. Delegate to the **qa**
   subagent to run it from the worktree: set up the local seed and test users, run
   the app, and validate each acceptance criterion against the **running app** —
   driving the browser if the project has E2E tooling, otherwise co-piloting with me
   (it asks me to log in and tells me what to click while I watch). It reports
   PASS/FAIL per criterion. If there's no `## QA plan`, skip this step. This is the
   only interactive touchpoint at the end.
9. Call `chamba_summarize_to_vault` with a summary of what changed.
10. STOP and report for my review. The report MUST include:
    - the repos touched and why;
    - per repo, what changed and the test + verify results;
    - an **acceptance-criteria checklist**: every AC of the ticket marked
      **Delivered** or **Not delivered** (fold in the qa agent's PASS/FAIL when a QA
      phase ran). Anything the plan marked **needs-approval**, or any AC you could
      not deliver or verify without a deferred decision, goes under **"Needs your
      decision"** with what's pending and why — never omit it;
    - the `.code-workspace` to open, and the suggested commit +
      `git merge --no-ff` commands.
    Do NOT commit, merge or push — I review, commit and send to my company's code
    review by hand.
