---
"@chamba/core": minor
"@chamba/mcp": minor
---

feat(memory): index-first vault recall + per-project grouping (Engram-style)

Recall no longer reads every note. Each vault folder keeps a lightweight `INDEX.md`
(`{title, path, description}`) that `chamba_load_context` scans first, opening full
notes only for the top matches — with a full-scan fallback so recall never regresses
on a legacy vault or an index miss. `chamba_summarize_to_vault` and `chamba_save_plan`
now group notes under a stable `<folder>/<owner-repo>/` subfolder derived from the git
remote (`slugifyGitRemote`), so every note for the same repo lands together and stays
deduped. Still no LLM — matching and indexing are mechanical.
