# @chamba/mcp

The **chamba MCP server** — adds orchestration, workspace context, git worktrees and
Obsidian memory to any MCP-capable editor (Cursor, Claude Code, VS Code/Copilot,
Windsurf, Cline, OpenCode, Zed, JetBrains, Gemini CLI, Codex, Trae, Kiro).

**No API key.** chamba never calls an LLM — your editor's model does the reasoning
and calls these tools.

## Install (in your editor)

**Cursor** — `.cursor/mcp.json`:

```json
{ "mcpServers": { "chamba": { "command": "npx", "args": ["-y", "@chamba/mcp"] } } }
```

**Claude Code**: `claude mcp add chamba -- npx -y @chamba/mcp`

**VS Code** — `.vscode/mcp.json` (note: VS Code uses `"servers"`, not `"mcpServers"`):

```json
{ "servers": { "chamba": { "type": "stdio", "command": "npx", "args": ["-y", "@chamba/mcp"] } } }
```

**More editors** (full guides in the repo's [`examples/`](https://github.com/thelord07/chamba/tree/main/examples)):
Gemini CLI (`~/.gemini/settings.json`, `mcpServers`) · Codex (`~/.codex/config.toml`, TOML
`[mcp_servers.chamba]`) · JetBrains AI Assistant (`mcpServers`) · Trae (`mcpServers`) · Zed
(`~/.config/zed/settings.json`, key `context_servers`) · Kiro (`.kiro/settings/mcp.json`).

Point at an Obsidian vault with `"env": { "CHAMBA_OBSIDIAN_VAULT_PATH": "/path/to/vault" }`.
If none is set, `chamba_workspace_init` bootstraps a global vault at `~/.chamba/vault` —
**outside your repos**, so notes/memory never get committed.

## Tools

**Workspace + context:** `chamba_workspace_init` · `chamba_workspace_show` ·
`chamba_workspace_reload` · `chamba_load_context` · `chamba_load_skills`

**Design (visual tickets):** `chamba_load_design` · `chamba_design_prefs` — link a Figma
URL / mockups folder / standalone `.html`·`.zip` prototype and set the UI-architecture
preference (Atomic Design, Feature-Sliced, …). No LLM.

**Triage + planning + review:** `chamba_triage_ticket` (heuristic ticket-completeness
check, no LLM — powers `/triage`) · `chamba_generate_plan` · `chamba_review_plan`
(heuristic, no LLM) · `chamba_save_plan`

**Worktrees (parallel work):** `chamba_create_worktree` · `chamba_create_worktrees` ·
`chamba_list_worktrees` · `chamba_worktree_status` · `chamba_conflict_preview` ·
`chamba_partition` · `chamba_worktree_env` · `chamba_cleanup_worktree` ·
`chamba_cleanup_worktrees`

**Memory + vault:** `chamba_remember` · `chamba_recall` · `chamba_summarize_to_vault` ·
`chamba_vault_status`

**Parche (group vaults):** `chamba_vault_join` · `chamba_vault_sync` · `chamba_parche_status`

**Health + capacity:** `chamba_doctor` · `chamba_resource_budget` (safe parallelism from
live RAM/CPU) · `chamba_qa_capabilities` (web/mobile QA probe) · `chamba_get_agent_config`

Full docs, per-editor guides and examples:
**https://github.com/thelord07/chamba**

## parche — group vaults

**parche** lets a team share an Obsidian vault and keep it in sync across machines,
without a web interface or a login flow. The server runs at `https://parche.chamba.tools`
(or self-hosted).

### How it works

1. One person creates an invite code on the parche server.
2. Each team member runs `vault join` to get a local copy of the vault.
3. Every call to `chamba_summarize_to_vault`, `chamba_remember`, `chamba_load_context`
   and `chamba_recall` automatically syncs the vault in the background (bounded to 10 s
   — if it times out the tool still returns normally plus a warning line).
4. The team's shared memories live in `<vault>/memory/`. Personal memories in
   `<cwd>/.chamba/memory/` are never uploaded.

### CLI commands

All commands run via `npx @chamba/mcp vault <subcommand>`.

| Command | Description |
|---|---|
| `vault join <code\|link> [--name NAME] [--email EMAIL] [--label LABEL] [--server URL]` | Join a parche group. With a TTY, `--name` and `--email` are prompted. `--label` defaults to the machine hostname. A link like `https://parche.chamba.tools/j/XXXX-XXXX` also sets the server. |
| `vault sync [slug]` | Sync one vault (by slug) or all vaults. Prints pushed/pulled/conflicts. |
| `vault status` | Show server, slug, role, last sync, pending changes, and vault path for each vault. |
| `vault leave <slug>` | Remove the credential for a vault. The files on disk are kept. |

### Error messages

| Status | Message |
|---|---|
| 404 | `código inválido, vencido o agotado` |
| 409 | `ya eres miembro: usa \`vault login\` en esta máquina (próximamente)` |
| 429 | `demasiados intentos, espera un minuto` |

### Memory: group vs personal

- `chamba_remember` with an active parche vault writes to `<vault>/memory/<key>.md` and syncs immediately.
- `chamba_recall` searches **both** the vault memory (tagged "grupo <slug>") and personal memory (tagged "personal, solo esta máquina").
- Personal memories in `<cwd>/.chamba/memory/` are **never** uploaded or moved.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `CHAMBA_PARCHE_URL` | `https://parche.chamba.tools` | Override the parche server URL. `http://` is only allowed for `localhost`/`127.0.0.1`/`[::1]`. |
| `CHAMBA_PARCHE_PULL_TTL_MIN` | `5` | Minutes before an automatic pull is triggered when reading context or memories. |

### Editor config (parche env vars)

**Cursor** — `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "chamba": {
      "command": "npx",
      "args": ["-y", "@chamba/mcp"],
      "env": {
        "CHAMBA_OBSIDIAN_VAULT_PATH": "/path/to/vault",
        "CHAMBA_PARCHE_URL": "https://parche.chamba.tools"
      }
    }
  }
}
```

**VS Code** — `.vscode/mcp.json` (note: VS Code uses `"servers"`, not `"mcpServers"`):

```json
{
  "servers": {
    "chamba": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@chamba/mcp"],
      "env": {
        "CHAMBA_OBSIDIAN_VAULT_PATH": "/path/to/vault"
      }
    }
  }
}
```

### Credentials

Credentials are stored in `~/.chamba/credentials.json` with mode `0600`. The token is
**never** returned by any MCP tool, never written to the vault, and never logged.

## License

MIT
