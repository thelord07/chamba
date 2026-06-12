---
"@chamba/core": minor
"@chamba/mcp": minor
---

`chamba_workspace_init` now bootstraps an Obsidian vault when none exists, so memory works from day one.

- New `VaultInitializer` (`@chamba/core`) drops the `.obsidian/` marker at a given root and seeds a `Workspace overview.md` note rendered from the scan. Idempotent: it never recreates the marker or overwrites an existing overview.
- `chamba_workspace_init` detects a vault (via `CHAMBA_OBSIDIAN_VAULT_PATH` or the usual search roots); if none is found it creates one at the workspace root and seeds the overview, otherwise it leaves the existing vault untouched. Because the workspace root is the first search root, the other tools (`load_context`, `summarize_to_vault`, `vault_status`) auto-detect it on the next run with no extra config. Opt out with `createVault: false`.
- chamba never edits `.gitignore`; the tool's output notes that `.obsidian/` was created so you can ignore it if you don't want it committed.
