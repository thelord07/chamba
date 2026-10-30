---
"@chamba/core": minor
"@chamba/mcp": minor
---

PARCHE-011: workspace-aware parche vault binding. Each workspace can keep its own `.chamba/parche.json` that binds to a specific group vault, taking precedence over the global binding and env-based detection. Adds `--scope workspace|global` to `vault join`, new `vault unlink` subcommand, `checkInvite` pre-validation, O2 bound-unsyncable handling in all tools, O3 workspace info in `chamba_vault_status` and `chamba_doctor`, and `CHAMBA_WORKSPACE_ROOT` env support.
