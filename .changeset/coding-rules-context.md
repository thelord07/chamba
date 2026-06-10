---
"@chamba/core": minor
"@chamba/adapters": minor
"@chamba/mcp": minor
"@chamba/claude-extras": minor
---

Multi-editor coding rules in context.

chamba now discovers each repo's coding-rule files across editor conventions —
`.cursor/rules`, `.cursorrules`, `CLAUDE.md`, `.claude/rules`, `.windsurfrules`,
`.trae`, `.github/copilot-instructions.md`, `.clinerules`, `AGENTS.md` — and reads
them **non-exclusively** (Claude Code users still get the Cursor/Trae rules).

- **core**: new `rules.ts` (catalog + `detectRuleSources` + `readRuleExcerpts`).
  The scanner enumerates the workspace's repos (root + child git repos + projects)
  and records a `ruleSources` inventory; `workspace.md` gains a `## Coding rules`
  section. `ContextBuilder` adds a `## Coding rules` block that reads each rule
  file fresh (clamped, budgeted) — so the rules in context are always current and
  never copied to the vault (no drift).
- **mcp**: `chamba_load_context` gains `includeRules` (default true).
