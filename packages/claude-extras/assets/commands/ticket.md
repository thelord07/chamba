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

**Orchestration capability.** The steps below delegate to subagents and run
verification passes. Use the richest orchestration your editor supports, and degrade
cleanly: with **parallel subagents**, fan out independent reviews/verifiers and
reconcile them; with **one subagent at a time**, run the passes sequentially; with
**no subagents**, do the work inline yourself. Never assume a specific editor
primitive — adapt to what you have.

Parse the arguments first. If they start with `-p` or `--plan`, the next token is
the path to a plan I already wrote (relative to the workspace root, or absolute) —
read it and skip planning (see step 2). The first non-flag token is the ticket id;
any tokens after it are repos I named explicitly. Analyze first, create worktrees
only for the repos actually touched — do not create a worktree for every repo in
the workspace.

1. Call `chamba_load_context` with the ticket to pull the workspace map (all repos
   and what each one is) + relevant Obsidian notes + each repo's coding rules. Also call
   `chamba_load_skills` with the ticket to surface any team playbooks/conventions that
   match — read the body of the ones it returns and follow them. If the ticket is visual,
   also call `chamba_load_design` to resolve any linked design source (mockups / Figma /
   standalone prototype) and the saved UI-architecture preference.
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
   through `chamba_review_plan` and have the **reviewer** subagent audit it. Fix and
   re-review until a full pass raises zero **new** blocking issues (dry) — an issue
   already listed and addressed is resolved, don't re-raise it — or 6 rounds,
   whichever comes first. Do NOT stop to ask me.
4. **Clarification gate.** Before creating any worktree, check the plan for
   unresolved **Open questions** and any item marked **needs-approval**;
   `chamba_review_plan` flags these as `unresolved-open-questions`. If there are
   any: ask me all of them in one concise batch, wait for my answers, fold them
   into the plan (adjust scope, subtasks and acceptance criteria as needed), and
   only then continue. If the plan has none, proceed without pausing. This is the
   only place you stop before the final review — it applies whether the plan came
   from the planner or from `-p`. Once the plan is final, call `chamba_save_plan`
   (title: the ticket id) to persist it under the vault's `plans/` folder.
5. Create isolated worktrees ONLY for the repos the plan identified: call
   `chamba_create_worktrees` with the ticket and that repo list. ALL work happens
   inside these worktrees — never edit the main checkouts. Its result includes
   `recommendedParallelism` — a safe number of repos to work at once for THIS machine's
   RAM/CPU **and** observed file overlap (or call `chamba_resource_budget` /
   `chamba_partition` yourself). Then call `chamba_worktree_status`. If it reports
   overlapping changed files, do **not** fan those worktrees out in parallel — run
   them in the waves `chamba_partition` (with `fromWorktrees: true`, or the plan for
   a predicted warning) returns. `chamba_conflict_preview` is a `git merge-tree`
   dry-run: never merge, never `--force`. If `worktrees.ports.enabled` is on, the
   create tool already wrote `.env.local` PORT values so two `/qa` servers do not
   bind `:3000`; otherwise call `chamba_worktree_env` before booting apps.
6. For each subtask/repo, delegate implementation to the **implementer** subagent
   (in that repo's worktree) and the tests to the **tester** subagent; run them. If the
   plan has a `## Design` section, the implementer builds to it — exact tokens/measures
   from a Figma MCP if one is configured, otherwise the linked mockups/standalone prototype
   + specs — and follows the saved UI architecture (`chamba_design_prefs`).
   **Respect the machine budget and overlap waves:** if `recommendedParallelism` is below
   the number of repos, or `chamba_partition` / `chamba_worktree_status` shows overlap,
   fan out in **waves** instead of launching a worker per repo at once — overlapping
   files in parallel is how merge conflicts get born, and on an 8/16 GB laptop every
   worker (dev server + build) running together can thrash or OOM. Say the cap and why
   in one line when it bites; the same applies to any dev servers the QA phase starts.
7. **Verify against the real diff** (not the plan). First call `chamba_conflict_preview`
   (merge-tree dry-run — it never merges). For each touched repo: have the
   **reviewer** subagent audit the actual diff for correctness, missing tests, and
   **referential closure** — anything the change deleted must leave no orphaned
   callers and no now-unused exports. Then run that repo's build / typecheck / lint,
   and a dead-code check if the repo has one (knip, ts-prune). Token grep alone
   misses orphans whose name doesn't contain the deleted symbol — rely on the
   build/typechecker/dead-code tool, not just grep. Fix what comes back, then
   re-verify until a full pass finds zero **new** blocking issues (dry) or 6 rounds,
   whichever comes first — don't re-report a finding you already fixed.
8. **Acceptance QA** — only if the plan has a `## QA plan`. Delegate to the **qa**
   subagent to **co-pilot** it from the worktree: apply the local data seed, ask me
   to provision any identity-provider users (Auth0/Firebase/…) rather than creating
   them itself, run the app, and validate each acceptance criterion against the
   **running app** — plus, when the plan has a `## Design` section, a **visual check**
   against the design reference (Figma MCP if configured, else the screenshots) —
   driving the browser if the project has E2E tooling, otherwise co-piloting with me.
   It first calls `chamba_qa_capabilities` to see what this project + machine support;
   for a **React Native / Expo** app it runs on a **simulator/emulator** (via the
   editor's mobile MCP, or `expo start` co-piloted) or Expo Go on my device. **The login
   is always my step**: it opens the app and asks me to log in (and to re-log in per
   user on multi-user flows) while it drives and watches. It reports PASS/FAIL per criterion, each backed by a numbered
   evidence screenshot in a per-run folder kept **outside any git repo**. If there's no
   `## QA plan`, skip this step. This is the only interactive touchpoint at the end.
9. Call `chamba_summarize_to_vault` with a summary of what changed.
10. STOP and report for my review. The report MUST include:
    - the repos touched and why;
    - per repo, what changed and the test + verify results;
    - an **acceptance-criteria checklist**: every AC of the ticket marked
      **Delivered** or **Not delivered** (fold in the qa agent's PASS/FAIL when a QA
      phase ran). Anything the plan marked **needs-approval**, or any AC you could
      not deliver or verify without a deferred decision, goes under **"Needs your
      decision"** with what's pending and why — never omit it;
    - **how to open the work**, as two copy-paste commands below the message, using
      the paths `chamba_create_worktrees` returned — VS Code: `code <the
      .code-workspace>` and Cursor: `cursor <the .code-workspace>` (fall back to the
      worktree directory if no workspace file was generated);
    - the suggested commit + `git merge --no-ff` commands.
    Do NOT commit, merge or push — I review, commit and send to my company's code
    review by hand.
