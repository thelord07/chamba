---
"@chamba/claude-extras": minor
"@chamba/cursor-extras": minor
"@chamba/opencode-extras": minor
---

Add `/babysit` — get a change merge-ready on any forge, any extras editor.

Shared slash command (Claude Code, Cursor, OpenCode): triage review comments,
resolve conflicts with the base, and fix in-scope CI without merging or
force-pushing. Detects the host from `git remote` and degrades to local verify
when no forge CLI is present.
