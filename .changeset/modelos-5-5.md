---
"@chamba/core": patch
---

Model catalog: add `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-fable-5-1`, so `~/.chamba/config.json` files that name them validate instead of being rejected as "unknown model" (which made chamba ignore the whole agent config). Defaults are unchanged (Opus 5 / Sonnet 5).
