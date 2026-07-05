---
"@chamba/core": minor
"@chamba/claude-extras": minor
---

Add Claude Fable 5 as an opt-in premium model (with honesty caveats) and make the orchestration prompts editor-aware.

- **Fable 5 in the catalog**: `claude-fable-5` (Anthropic, opt-in — never a default). New optional `ModelInfo` fields (`pricing_note`, `requires_data_retention`, `can_refuse`) + a `modelCaveat()` helper surface its caveats everywhere a role is chosen: the wizard prints an advisory on select, `chamba_get_agent_config`'s hint + `caveat` field carry it, and the generated subagent frontmatter adds a `# ...` comment line. This stops the "chamba is broken" trap where a zero-retention org selects Fable 5 and their editor 400s.
- **Honest about the effort ceiling**: documented (catalog, README) that chamba's abstract `extreme` maps to `max` on the Anthropic/Claude Code path (it maps to `xhigh` only for OpenAI), so Fable 5's recommended `xhigh` isn't reachable there — a Fable 5 role runs at `high` or `max`.
- **Editor-capability degrade preamble** added to `/ticket`, `/qa`, `/orq`, `/map`: use the richest orchestration the editor supports (parallel subagents → sequential → inline) and degrade cleanly, without naming any editor primitive. Keeps richer flows Claude-Code-friendly while staying editor-agnostic.
- **Loop-until-dry** with a hard cap replaces the fixed "max 3 rounds" in the `/ticket` review + verify loops and `/orq` review: loop until a full pass raises zero new blocking issues, or 6 rounds, with explicit dedup so it can't spin re-reporting fixed findings.
