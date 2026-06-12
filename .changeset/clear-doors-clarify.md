---
"@chamba/core": patch
"@chamba/claude-extras": patch
---

Add a clarification gate so `/ticket` resolves plan ambiguities before executing instead of guessing.

- The **planner** now puts genuine forks (scope/behaviour changes, product decisions only the human can make) under a `## Open questions` section instead of silently assuming.
- `validatePlan` warns (`unresolved-open-questions`, non-blocking) when the plan has an Open questions section with items that aren't marked answered — the signal for the orchestrator to ask.
- `/ticket` gained a **clarification gate** between review and worktree creation: if the plan has unresolved open questions or `needs-approval` items, it asks you in one batch, folds your answers into the plan, and only then executes. Clear plans proceed without pausing. The gate applies to `-p` plans too. This is the one deliberate pause; after it, the flow runs to the end as before.
