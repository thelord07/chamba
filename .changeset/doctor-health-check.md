---
"@chamba/core": minor
"@chamba/mcp": minor
---

feat(doctor): environment health check — `chamba_doctor` tool + `npx @chamba/mcp doctor`

A no-LLM diagnostic that validates the setup and tells you exactly what to fix:
Node version, git, whether the cwd is a git repo, `.chamba/workspace.md`, agent
config validity, the Obsidian vault connection, the log directory, and worktrees.
Returns a pass/warn/fail report (and a non-zero exit code from the CLI when a check
fails, so it works as a CI gate). Shared pure logic in `@chamba/core` (`runDoctor`,
`renderDoctorReport`) drives both the MCP tool and the CLI subcommand.
