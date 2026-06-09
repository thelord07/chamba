---
description: Orchestrate a task end-to-end using chamba's MCP tools
argument-hint: <task>
---

You are orchestrating this task with chamba's MCP tools: **$ARGUMENTS**

Follow the orchestrator-worker flow. chamba provides context, plan validation,
worktrees and vault writing; you do the reasoning and the code.

1. Call `chamba_load_context` with the task to pull workspace + relevant notes.
2. Call `chamba_generate_plan` to get a plan template, then fill it in concretely
   (goal, acceptance criteria, subtasks with workers, risks, files).
3. Call `chamba_review_plan` with your plan. If `approved` is false, fix the
   reported issues and review again (max 3 rounds).
4. Show me the approved plan and wait for my go-ahead.
5. If this is a git repo, call `chamba_create_worktree` per worker for isolation.
6. Implement the change, write/extend tests, and run them.
7. When done, call `chamba_summarize_to_vault` with a summary of what changed.
8. Leave any worktree branches open — do not merge. Tell me the merge command.
