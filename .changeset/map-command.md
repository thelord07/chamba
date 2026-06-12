---
"@chamba/claude-extras": patch
---

New `/map` command: bootstrap the cross-repo architecture into the vault.

`/map` reads the workspace's repos for their wiring (REST, async/events, shared data, build deps) and writes living vault notes — `Topology.md`, `Data flows.md`, `Domain entities.md` and `repos/<repo>.md` — with stable names so re-runs update in place. It resolves the vault via `chamba_vault_status` (run `/workspace init` first if you don't have one), asks whether to write in English or Spanish (or pass `en`/`es`), and never overwrites a note you edited by hand (only notes marked `source: chamba`). Opt-in and grounded in real code — built for small or new projects where mapping everything is cheap.
