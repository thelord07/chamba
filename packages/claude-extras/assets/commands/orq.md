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

1. Call `chamba_load_context` with the task to pull workspace + relevant notes, and
   `chamba_load_skills` for matching team playbooks — read and follow the ones it returns.
2. Delegate to the **planner** subagent to produce the plan (goal, acceptance
   criteria, subtasks with workers, risks, files).
3. Call `chamba_review_plan` with the plan and have the **reviewer** subagent
   audit it. If not approved, fix the issues and review again until a full pass
   raises zero **new** blocking issues (dry) or 6 rounds, whichever comes first —
   don't re-raise an issue you already addressed.
4. Save the approved plan with `chamba_save_plan` (it lands under the vault's
   `plans/` folder), then show it to me and wait for my go-ahead.
5. If this is a git repo, call `chamba_create_worktree` per worker for isolation.
6. Delegate implementation to the **implementer** subagent (in its worktree) and
   the tests to the **tester** subagent; run them. When you fan out across several
   workers, first check `chamba_resource_budget` (pass the worker count) and run in
   **waves** of `recommended` — don't launch every worker at once on a small machine.
7. When done, call `chamba_summarize_to_vault` with a summary of what changed.
8. Leave any worktree branches open — do not merge. Tell me the merge command.
