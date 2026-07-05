---
"@chamba/core": minor
"@chamba/mcp": minor
"@chamba/claude-extras": patch
---

Save plans to the vault and surface open-in-editor commands.

- New **`chamba_save_plan`** tool writes a finalized plan to the vault's `plans/` folder (`plans/<date>-<slug>.md`, tagged `[chamba, plan]`), alongside the run summaries that go under `proyectos/`. `VaultWriter` gained an optional `subdir` so both share one writer; `VAULT_PLANS_DIR` is exported from `@chamba/core`.
- `/ticket` now saves the final plan (after the clarification gate) and `/orq` saves the approved plan — every plan is persisted, not just the end-of-run summary.
- `/ticket`'s final report now prints two copy-paste commands below the message to open the work: `code <.code-workspace>` for VS Code and `cursor <.code-workspace>` for Cursor (falling back to the worktree directory).
