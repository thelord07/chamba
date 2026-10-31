---
"@chamba/core": minor
"@chamba/mcp": minor
"@chamba/claude-extras": minor
"@chamba/cursor-extras": minor
"@chamba/opencode-extras": minor
---

PARCHE-010: `/parche` command and vault link/unlink/resync tools. Adds `chamba_vault_link`, `chamba_vault_unlink`, `chamba_vault_resync` MCP tools; `scope` parameter to `chamba_vault_join`; `movedToTrashEntries` to `SyncSummary`; binding header in `chamba_parche_status` and `chamba_vault_status`; `pendingJoinCodeHash` in sync state for safe join resume; `clearPendingAdoption`/`pendingJoinCodeHashOf` helpers; shared `binding-ops.ts` orchestration module; `vault resync` CLI subcommand; and the `/parche` slash command for all editors.

**Upgrade desde 1.9.0:** los vaults pendientes de confirmar se confirman con `chamba_vault_link` o `npx @chamba/mcp vault link <slug> --dir <dir> --yes`.
