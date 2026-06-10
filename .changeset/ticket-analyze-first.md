---
"@chamba/claude-extras": patch
---

`/ticket`: analyze first, then create worktrees only for the repos actually
touched. The orchestrator now loads context and has the planner identify which
repos the ticket touches before calling `chamba_create_worktrees` — so running
`/ticket TICKET-123` with no repos infers them from the ticket + workspace map
instead of creating a worktree for every repo.
