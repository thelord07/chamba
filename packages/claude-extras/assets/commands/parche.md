---
description: Manage your parche group vault from the editor — status, sync, join, link, resync, unlink
argument-hint: "[status|sync|join|link|resync|unlink] [args]"
---

Run the parche subcommand in **$ARGUMENTS** (default: `status`). parche is chamba's
group vault sync. Follow these rules for EVERY subcommand:

- **Never show or ask for tokens.** The tools never return the device token; never
  ask me for one and never print one. Don't echo invite codes back in your summaries
  either.
- **Never delete anything.** These tools never remove files. If a sync reports
  conflicts, explain where each copy was saved — never "clean up" or delete.
- **Confirm before uploading.** When a tool returns `needsConfirmation` (an existing
  folder has files that would be uploaded), show me the summary (how many files, how
  many are ignored, the sample list) and ask me to confirm BEFORE calling again with
  `confirmUpload: true`. Never pass `confirmUpload: true` on your own.
- **On a network or server error, say so plainly and stop — do not retry in a loop.**

### status  (also the default)
Call `chamba_parche_status`. Show FIRST the active workspace binding from its
`binding` / `workspaceRoot` fields: scope (workspace / global / none), slug, vault
path, autoSync (on/off + pull TTL), and where the workspace came from (cwd or
`CHAMBA_WORKSPACE_ROOT`). THEN show the per-vault table (slug, role, path, last sync,
pending changes) for every parche on this machine.

### sync [slug]
Call `chamba_vault_sync` (pass `slug` if I gave one). Summarize per vault: pushed,
pulled, and — if any — list each conflict copy (`conflicts[].path` → the exact
`copyPath` it was saved as) and each file moved to `.trash/` (`movedToTrash[].path` →
`trashPath`). If `truncated` is present, say how many more were not listed. Report
errors plainly; do not retry.

### join <code> [dir]
Join a group vault. If you don't already know my name and email, ask for them. Call
`chamba_vault_join` with `code`, `name`, `email` (and `dir` if I gave one).
- If it returns `needsScope` (I'm inside a workspace), ask me whether to bind this
  parche to the **workspace** (`.chamba/parche.json`; default vault `<workspace>/vault`)
  or keep it **global**, then call again with `scope: "workspace"` or `scope: "global"`.
  Do NOT join until I choose.
- If it returns an error that the workspace is already bound to another parche,
  explain it and offer `/parche unlink` — do NOT overwrite it.
- If it returns `needsConfirmation`, apply the confirm-before-upload rule, then call
  again with the SAME `code`, `scope` and `dir` plus `confirmUpload: true`. Keep those
  arguments on every retry: a different code is treated as a new join, not as the
  confirmation (it can leave another vault pending).
- If it says a pending adoption was created by an older version, confirm it with
  `chamba_vault_link` (the slug and folder it names, plus `confirmUpload: true` after
  I agree) instead of joining again.

### link <slug> <dir>
Re-point an existing vault at a new folder. Call `chamba_vault_link` with `slug` and
`dir`. Same confirm-before-upload rule via `confirmUpload: true`. The old folder is
left on disk untouched — tell me so. If I abandon the flow after `needsConfirmation`,
tell me the vault now points at the new folder (pending) and that I can point it back
with `/parche link <slug> <old folder>`.

### resync <slug>
Recover a vault whose sync state is broken or stale. Call `chamba_vault_resync` with
`slug`. It resets the sync state in the SAME folder and re-adopts safely — nothing is
deleted or overwritten; divergent files come back as `(conflicto …)` copies. Same
confirm-before-upload rule via `confirmUpload: true`. Afterwards list the conflict
copies and anything moved to `.trash/`, as in `sync`.

### unlink [workspace|global]
Call `chamba_vault_unlink` (pass `scope` if I gave one). This removes ONLY the
`.chamba/parche.json` binding — it never touches the credential or any vault files.
Confirm which scope was removed.
