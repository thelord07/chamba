---
"@chamba/core": patch
"@chamba/adapters": patch
"@chamba/mcp": patch
"@chamba/claude-extras": patch
---

Obsidian vault: diagnostics + auto-correct a `.obsidian` path.

- **core**: `ObsidianDetector` now auto-corrects a vault path that points at the
  `.obsidian` folder to its parent (the actual vault). A common misconfiguration
  made chamba write summaries into `.obsidian/proyectos/` and search notes inside
  `.obsidian/` instead of the real vault. New `listVaultNotes` + `normalizeVaultPath`.
- **mcp**: new `chamba_vault_status` tool (#16) — shows the resolved vault path,
  whether it came from the env var or autodetection, and the markdown notes chamba
  can actually see (the same set `chamba_load_context` searches).
- **claude-extras**: new `/vault` slash command to run the diagnostic.
