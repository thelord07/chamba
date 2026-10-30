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
| `vault join <code\|link> [--name NAME] [--email EMAIL] [--label LABEL] [--server URL] [--dir PATH] [--allow-in-repo] [--yes]` | Join a parche group. With a TTY, `--name` and `--email` are prompted. `--label` defaults to the machine hostname. A link like `https://parche.chamba.tools/j/XXXX-XXXX` also sets the server. Use `--dir` to set a custom vault location. |
| `vault link <slug> --dir <PATH> [--allow-in-repo] [--yes]` | Re-link an existing vault to a new local directory. Resets the local state and runs the adoption gate. The old directory is kept intact. |
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

## Usar tu propio vault / Use your own vault

### Español

Por defecto, `vault join` guarda el vault en `~/.chamba/vaults/<slug>/`. Puedes usar
cualquier carpeta con `--dir`:

```bash
# Apuntar a un vault de Obsidian ya existente
npx @chamba/mcp vault join K7QX-M2RP \
  --name "Joys" --email "joys@example.com" \
  --dir ~/Documents/ObsidianVault \
  --yes

# Vincular un vault ya unido a una nueva ruta
npx @chamba/mcp vault link mi-equipo \
  --dir ~/Documents/ObsidianVault \
  --yes
```

**Reglas:**
- `--dir ~`, `--dir /`, `--dir /etc`, `--dir /Users`, etc. son rechazados.
- `--dir` dentro de un repositorio git requiere `--allow-in-repo` (agrega `.chamba-sync/` al `.gitignore`).
- Si el directorio tiene archivos existentes, se muestra un resumen antes de subir nada.  
  Sin TTY y sin `--yes`, no sube nada, sale con error y el vault queda "pendiente de confirmar" (ni `vault sync` ni el autosync suben) hasta `vault link <slug> --dir <ruta> --yes`.
- `vault link` no mueve ni borra la ruta anterior — solo cambia la credencial y resetea el estado.

**Autosync con ruta propia:** Para que `chamba_summarize_to_vault`, `chamba_load_context`, `chamba_remember` y
`chamba_recall` autosincronicen el vault, `CHAMBA_OBSIDIAN_VAULT_PATH` debe apuntar a la
misma ruta que usaste en `--dir`:

```json
"env": { "CHAMBA_OBSIDIAN_VAULT_PATH": "/ruta/propia" }
```

---

### English

By default, `vault join` saves the vault at `~/.chamba/vaults/<slug>/`. You can use any
folder with `--dir`:

```bash
# Point at an existing Obsidian vault
npx @chamba/mcp vault join K7QX-M2RP \
  --name "Joys" --email "joys@example.com" \
  --dir ~/Documents/ObsidianVault \
  --yes

# Re-link an already-joined vault to a new path
npx @chamba/mcp vault link my-team \
  --dir ~/Documents/ObsidianVault \
  --yes
```

**Rules:**
- `--dir ~`, `--dir /`, system directories, etc. are rejected.
- `--dir` inside a git repo requires `--allow-in-repo` (adds `.chamba-sync/` to `.gitignore`).
- If the directory has existing files, a summary is printed before uploading anything.  
  Without a TTY and without `--yes`, nothing is uploaded, the command exits with an error and the vault stays "pending confirmation" (neither `vault sync` nor autosync upload) until `vault link <slug> --dir <path> --yes`.
- `vault link` does not move or delete the old directory — it only updates the credential
  and resets the local state.

**Autosync with a custom path:** For `chamba_summarize_to_vault`, `chamba_remember` and
`chamba_recall` to autosync the vault, `CHAMBA_OBSIDIAN_VAULT_PATH` must point to the same
path you used with `--dir`:

```json
"env": { "CHAMBA_OBSIDIAN_VAULT_PATH": "/your/custom/path" }
```

## License

MIT
