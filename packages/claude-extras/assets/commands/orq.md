---
description: Orchestrate a task end-to-end using chamba's MCP tools
argument-hint: <task>
---

You are orchestrating this task with chamba's MCP tools: **$ARGUMENTS**

Follow the orchestrator-worker flow. chamba provides context, plan validation,
worktrees and vault writing; you orchestrate and delegate to the subagents (which
run with the model + effort you configured via `chamba-config`).

**Orchestration capability.** Use the richest orchestration your editor supports, and
degrade cleanly: with **parallel subagents**, fan out independent reviews/verifiers
and reconcile them; with **one subagent at a time**, run the passes sequentially; with
**no subagents**, do the work inline yourself. Never assume a specific editor
primitive — adapt to what you have.

**Routes.** chamba picks the route heuristically and announces it in one line. Use
`--route trivial|small|substantial|risky` to override. Exception: `risky` always asks
for your confirmation before implementation starts.

| Route | Plan | Plan review | Implementation | Verification | QA | Vault |
|---|---|---|---|---|---|---|
| trivial | no planner; 3-line inline summary | no | 1 worktree, implementer | lint + existing tests in the touched area | no (unless explicit visual criterion) | short summary |
| small | brief plan by implementer (≤ 10 lines) | no | 1 worktree, implementer + tester | new/adjusted tests + 1 reviewer pass on diff ("skip style") | if visual criterion present | summary |
| substantial | planner | máx. 2 rondas | worktrees per repo, implementer + tester | re-verify máx. 2 rondas | if `## QA plan` present | plan + summary |
| risky | planner + mark `needs-approval` | máx. 2 rondas | same as substantial, **after your confirmation** | reviewer focused on risk + DB guard reminder (CHAMBA-013) | if visual criterion present | plan + summary |

**D1 — route decision:** chamba announces the route with a one-line reason; you decide.
Say so or pass `--route` to change it. **risky always asks for your confirmation** before
implementation starts — it never proceeds silently.

**D3 — escalation:** a route is never silently downgraded. If during implementation an
unexpected repo is touched, risk signals appear in the diff (migration files, auth-related
files, `.env*` files) or more than 15 files change, escalate one level, announce it, and
call `chamba_task_metrics(action='event', kind='escalation', toRoute=<new_route>)`. In
`risky`, ask for confirmation again before continuing.

1. Call `chamba_load_context` with the task to pull workspace + relevant notes, and
   `chamba_load_skills` for matching team playbooks — read and follow the ones it returns.
   If the task is visual, also call `chamba_load_design` for any linked design source + the
   saved UI-architecture preference.
   **Classify the task:**
   a. Call `chamba_triage_ticket` with the task description to check completeness.
   b. Call `chamba_classify_task` with the task description to get the route. If `--route`
      was given, use that (but still call `chamba_classify_task` to surface signals).
   c. Announce in one line: "Ruta: **X** (reason). Si prefieres otra, dime o usa `--route`."
   d. Build the workItem: `orq-<ISO compact UTC>` (e.g. `orq-20261107T153010Z`). Call
      `chamba_task_metrics(action='start', workItem=<workItem>, routeSuggested=<route>,
      source='orq')`. If the user's `--route` differs, also emit event `kind='override'`.

2. Obtain the plan based on the route:
   - **trivial:** write a 3-line inline summary: what changes, what file(s), why. Skip step 3.
   - **small:** have the **implementer** subagent produce a brief plan (≤ 10 lines): what
     changes, which files, what tests. No `chamba_review_plan`. Skip step 3.
   - **substantial or risky:** delegate to the **planner** subagent to produce the plan
     (goal, acceptance criteria, subtasks with workers, risks, files). For **risky**, the
     plan MUST mark each sensitive item **needs-approval**. Continue to step 3.

3. *(Skip for trivial and small — no plan review for those routes.)*
   Call `chamba_review_plan` with the plan and have the **reviewer** subagent audit it.
   Fix and re-review until a full pass raises zero **new** blocking issues (dry) or
   **máx. 2 rondas**, whichever comes first — don't re-raise an issue you already addressed.
   After each review round, call `chamba_task_metrics(action='event', workItem=<workItem>,
   kind='planReview')`.

4. Save the approved plan with `chamba_save_plan` (it lands under the vault's `plans/` folder),
   then show it to me and wait for my go-ahead. For **risky**, also summarize the
   `needs-approval` items and ask for explicit confirmation before continuing.
   **Knowledge network:** read the 5 closest nodes the tool returns before choosing
   `temas`; several topics → one note with several `temas`, never separate notes;
   `summary` says what the plan is about; `keywords` with endpoints, entities, IDs;
   `workItem` if it belongs to a ticket/HU; unknown topics → `temas_propuestos`.

5. If this is a git repo, call `chamba_create_worktree` per worker for isolation.
   When you fan out across several workers, first check `chamba_resource_budget`
   (pass the worker count) **and** `chamba_worktree_status` / `chamba_partition` —
   run in **waves** of `recommended`, and never in parallel when files overlap.
   Don't launch every worker at once on a small machine. `chamba_conflict_preview`
   is a dry-run; never merge.

6. Delegate implementation to the **implementer** subagent (in its worktree) and
   the tests to the **tester** subagent; run them.
   **D3 — watch for escalation signals:** if an unexpected repo is touched, migration or
   auth files appear, `.env*` files are modified, or more than 15 files change, escalate
   one route level, announce it, and call
   `chamba_task_metrics(action='event', workItem=<workItem>, kind='escalation',
   toRoute=<new_route>)`. In `risky`, ask for confirmation again before continuing.
   After each verification pass, call `chamba_task_metrics(action='event',
   workItem=<workItem>, kind='verify')`.

7. When done, call `chamba_summarize_to_vault` with a summary of what changed.
   **Knowledge network:** read the 5 closest nodes the tool returns; `summary` says
   what changed (not "session summary"); `keywords` with endpoints, entities, IDs;
   `workItem` if it belongs to a ticket/HU; several topics → one note with several
   `temas`; unknown topics → `temas_propuestos`.

8. Call `chamba_task_metrics(action='end', workItem=<workItem>, testsPassed=<bool>,
   qaResult='skipped', delivered=<bool>)`. Leave any worktree branches open — do not
   merge. Tell me the merge command.
