---
"@chamba/claude-extras": patch
---

`/ticket` now accepts `-p <plan-path>` (alias `--plan`) to reuse a plan you already wrote instead of regenerating it.

When `-p` points at an existing file, the orchestrator reads it, skips the planner, and runs only `chamba_review_plan` to sanity-check structure and surface issues — it does not bring in the reviewer subagent to rewrite a plan you already approved. If the path doesn't exist it warns and falls back to generating the plan; without `-p` the flow is unchanged. No core/MCP changes — purely the `/ticket` command asset.
