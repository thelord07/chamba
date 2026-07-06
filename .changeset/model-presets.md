---
"@chamba/core": minor
"@chamba/claude-extras": minor
---

feat(config): model presets — `config preset <budget|balanced|quality|fast>`

Named model+effort bundles that set every role at once, layered on the existing
per-role config. `PRESETS` live in `@chamba/core` (validated: every preset covers
all roles with catalog models). `ConfigStore.setPreset` writes the preset as the
`defaults` block while preserving per-role overrides and the worktrees policy. New
CLI verbs `config preset <name>` and `config presets`, plus a preset option in the
install wizard. `chamba_get_agent_config` picks them up automatically. Still no LLM.
