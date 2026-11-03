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
`chamba_save_plan` · `chamba_vault_status` · `chamba_vault_topics` · `chamba_vault_classify` ·
`chamba_vault_reindex`

**Parche (group vaults):** `chamba_vault_join` · `chamba_vault_link` · `chamba_vault_unlink` · `chamba_vault_resync` · `chamba_vault_sync` · `chamba_parche_status`

**Health + capacity:** `chamba_doctor` · `chamba_resource_budget` (safe parallelism from
live RAM/CPU) · `chamba_qa_capabilities` (web/mobile QA probe) · `chamba_get_agent_config`

Full docs, per-editor guides and examples:
**https://github.com/thelord07/chamba**

## Knowledge network

One note, written once, connected to all its topics via hierarchical tags (`tema/…`).
chamba derives a navigable network from the note metadata: a root `INDEX.md`, topic
hubs, and optionally Obsidian Bases — without duplicating any note.

### Note metadata contract

```yaml
---
title: "HU LMS API 01 — cursos y módulos"
date: 2026-10-29
type: plan             # plan | resumen | investigacion | informe | decision | guia | nota
summary: "Endpoints for course/module creation and management in LMS API with API key auth."
tags:
  - tema/lms/cursos/creacion
  - tema/lms/cursos/gestion
  - tema/lms/gamificacion
  - chamba
keywords: [POST /courses, módulos, api key, hu-lms-api-01]   # 0..10, each ≤ 40 chars
aliases: ["cursos LMS API"]          # optional, native Obsidian
work_item: hu-lms-api-01             # optional: groups plan/summary/report for the same HU/ticket
project: lapzo-lms-api               # optional (slugifyGitRemote)
related: ["plans/2026-10-29-hu-lms-api-01.md"]   # optional, vault-relative paths
temas_propuestos: [lms/certificados] # optional: requested topics not yet in the vocabulary
source: chamba
---
```

- **Topics = `tema/…` tags** (the only source; Obsidian renders them as a tree). Declare
  the most specific node; ancestors are implicit.
- A note can have 1–5 topics. A ticket that touches several topics → **one note with
  several `temas`**, never duplicate notes.
- `summary`: one line explaining what the note is about (≤ 200 chars), written on
  purpose — not "session summary".
- `keywords`: concrete terms to find the note without opening it (endpoints, entity
  names, IDs).
- `work_item`: links a plan note and a summary note for the same HU/ticket.
- Unknown topics go in `temas_propuestos`; chamba never invents vocabulary.
- Tolerant parser: missing/partial/invalid frontmatter → valid note, `type: nota`,
  no topics ⇒ "sin clasificar". Unknown fields are preserved byte-for-byte on rewrite.

### Vocabulary (`temas/VOCABULARIO.md`)

The human controls the vocabulary. Format:

```markdown
---
title: "Vocabulario de temas"
source: human
umbral_promover: 3     # proposals with ≥ N notes are offered for approval
umbral_dividir: 25     # nodes with > N direct notes are offered for splitting
generar_bases: true    # set to false to disable .base file generation
---
# Vocabulario de temas
- `lms` — LMS de Lapzo. Alias: plataforma
  - `lms/cursos` — Courses and their lifecycle.
    - `lms/cursos/creacion` — Course/module/lesson creation. Alias: crear-cursos
    - `lms/cursos/gestion` — Editing, publishing, archiving.
  - `lms/gamificacion` — Points, badges, rankings. Alias: gamification
- `soporte` — Bugs and CyA support tasks.
```

Rules: slug segments `^[a-z0-9]+(-[a-z0-9]+)*$`, depth ≤ 4, every declared node must
have its parent declared, aliases unique across the whole vocabulary (including slugs).

If the vocabulary does not exist, chamba creates it empty with instructions; it never
invents topics. All writes keep working without a vocabulary (notes go to "sin clasificar"
with a warning).

### Bootstrapping (`/vault iniciar`)

Run `/vault iniciar` in your editor to start the knowledge network:

1. The agent calls `chamba_vault_topics action=bootstrap` for deterministic vault
   statistics (folder counts, existing tags, frequent terms, detected work items).
2. The agent proposes a topic tree (≤ 30 nodes, ≤ 3 levels) and shows it to you.
3. The agent calls `chamba_vault_topics action=apply dryRun:true` — **shows you the
   exact `VOCABULARIO.md` content that would be written**.
4. **Only after your explicit "yes" in a separate turn** does it call `action=apply
   dryRun:false` (with `replace:true` if a vocabulary already exists, after confirming
   with you). Never chained automatically. *(O1)*
5. After writing the vocabulary, the agent offers to run backfill (`/vault clasificar`).

### Daily writing

`chamba_summarize_to_vault` and `chamba_save_plan` both accept:
`summary`, `temas` (vocabulary paths, 1..5), `keywords`, `aliases`, `workItem`, `related`,
`type` (`resumen` default for summarize; `plan` fixed for save_plan).

Both tools respond with: the compact topic tree (≤ 60 lines) and the **5 closest nodes**
to `title + summary + keywords` — so the agent can reuse before proposing. Read those
nodes before choosing `temas`.

Validation: valid paths → `tags: tema/…`; an alias is resolved to its canonical path;
unknown paths → `temas_propuestos` (the tool says so, with suggestions). If no valid
topic remains, the note is saved unclassified with a warning.

`work_item` cross-linking: if a note with the same `workItem` already exists in the
vault with `source: chamba`, chamba adds a `related` back-link to it. Human notes are
never edited in this flow.

### Vocabulary evolution

- `temas/PROPUESTOS.md` (derived): each proposed topic with its requesting notes;
  those reaching `umbral_promover` appear as "ready to promote".
- `chamba_vault_topics action=add|alias`: modify `VOCABULARIO.md` — **only when the
  user explicitly asks**.
- `chamba_vault_topics action=promote path=<topic> description=<desc>`: **always
  `dryRun:true` first** (shows the list of notes that will be updated); call
  `dryRun:false` only after explicit user confirmation (bulk action).

### Backfill (`chamba_vault_classify`)

- `action=list`: unclassified notes (path, title, first paragraph ≤ 300), paginated 50.
- `action=apply entries=[…]`: assign topics to up to 50 notes per call. **`dryRun:true`
  by default** — shows a before/after diff of the frontmatter. Call `dryRun:false` only
  after explicit user confirmation. The body is preserved byte-for-byte.

### Reindex

`chamba_vault_reindex` (and CLI `npx @chamba/mcp vault reindex [--dry-run]
[--adopt-manual <folder> …] [--yes]`) rebuilds all derived files deterministically:

- Root `INDEX.md`: first-level topics with total counts, folders, "sin clasificar" count,
  link to `temas/PROPUESTOS.md` if there are proposals.
- Hub per node `temas/<path>.md` (e.g. `temas/lms.md`, `temas/lms/cursos.md`): description,
  aliases, link to parent, subtopics with counts, notes grouped by `type` then `work_item`.
- `temas/sin-clasificar.md`: notes without topics.
- `<folder>/INDEX.md` (recursive, excluding `memory/`, `.trash/`, `.obsidian/`, `temas/`):
  entries grouped by the note's first topic.

Determinism: NFC, LF, `/`, relative links, stable order (topic path → type → work_item →
date desc → path asc, case-insensitive with exact tiebreak), no generation timestamps.
Same notes → same bytes on any machine and OS.

Reindex runs automatically: after every write (incremental) and after a parche pull that
changed notes or derived files (full; 2 s budget; if exceeded, a warning is shown and it
completes on the next sync).

`--adopt-manual` / `adoptManual` *(O2)*: **never automatic**. To adopt a manually-written
`INDEX.md` (no `source: chamba`), call with `adoptManual: ["folder/"]` — `dryRun:true` by
default, shows which files will be renamed to `INDEX (manual).md` and replaced; call with
`dryRun:false` only after explicit user confirmation. If `INDEX (manual).md` already exists,
the tool errors. Unconfirmed manual `INDEX.md` files are reported in `indicesManualesOmitidos`.

### Derived files and conflict resolution

All derived files (`INDEX.md` generated by chamba, `temas/**/*.md` except `VOCABULARIO.md`,
`temas/*.base`) carry `source: chamba` + `generated: true` (or a `generated: true` YAML
comment for `.base` files) and the notice: "Generated by chamba from note metadata. Do not
edit: edit the notes or `temas/VOCABULARIO.md`."

On a parche pull conflict: if the local version is derived (pattern + `source: chamba` +
`generated: true`) or does not exist → the remote is accepted without a conflict copy, and
reindex is scheduled. `VOCABULARIO.md` and note files follow the normal conflict flow (a
copy is created). The network converges: two clients with the same notes reach identical
bytes without conflict copies or ping-pong.

### Obsidian Bases (optional)

`temas/<root>.base` per first-level topic: table filtered by `file.hasTag("tema/<root>")`,
columns `file.name`, `type`, `summary`, `work_item`, `date`, grouped by `type`. Disable
with `generar_bases: false` in `VOCABULARIO.md` frontmatter.

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
| `vault resync <slug> [--yes]` | Reset state in-place and re-adopt a vault (re-download from server). Useful when local state is corrupted. Runs the adoption gate; use `--yes` to confirm upload. |
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

On **Windows** the file lives in `%USERPROFILE%\.chamba\credentials.json`. `chmod` doesn't
restrict access there, so after every write chamba runs `icacls` to remove inherited
permissions and grant access only to the current user. If that fails (for example, a
domain account that `icacls` can't resolve), you get a warning and the command still
finishes; the file then keeps the permissions inherited from your user profile, which is
private by default.

Note that `/inheritance:r` removes **every** inherited entry, including `SYSTEM` and
`Administrators`: after hardening, only your user can read or write `credentials.json`.
Backup tools or admin scripts that run as `SYSTEM` or as an administrator can no longer
read it (an administrator can still take ownership of the file). That's intended (it holds your device token). If you need to restore their
access, re-enable inheritance with `icacls "%USERPROFILE%\.chamba\credentials.json" /inheritance:e`;
chamba applies the restriction again the next time it rewrites the file.

### Windows

The parche client works the same on Windows (PowerShell), macOS and Linux. Absolute paths
like `D:\workspace\vault`, `d:/workspace/vault` and UNC paths (`\\server\share\vault`)
are supported:

```powershell
cd D:\workspace
npx @chamba/mcp vault join K7QX-M2RP --scope workspace --dir D:\workspace\vault
# The folder already has notes: review the upload summary, then confirm
npx @chamba/mcp vault join K7QX-M2RP --scope workspace --dir D:\workspace\vault --yes
npx @chamba/mcp vault sync
```

- Drive-relative paths (`C:notes`, no slash after the colon) and device paths
  (`\\?\…`, `\\.\…`) are rejected with a clear error — use a normal absolute path.
- Files whose names are invalid on Windows (`CON.md`, `a:b.md`, names with `?` or `*`,
  or ending in a space or dot) are **not** created on Windows machines. The sync reports
  them, keeps them pending (they are never deleted for the rest of the group) and retries
  on every sync; `vault status` shows how many are pending. When someone on macOS/Linux
  pushes such a name, their sync warns that it won't sync on Windows.
- Paths longer than 260 characters need Windows long-path support
  (`LongPathsEnabled`); chamba doesn't add the `\\?\` prefix itself.

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

## Workspace-aware parche binding (PARCHE-011) / Vínculo de parche por workspace

### English

Each workspace (any directory that contains `.chamba/workspace.md`) can keep its own
**parche binding** in `.chamba/parche.json`. That binding overrides everything else —
including `CHAMBA_OBSIDIAN_VAULT_PATH` and the global `~/.chamba/parche.json` — and is
**authoritative**: if it exists but cannot be synced (wrong path, missing credential, etc.)
the tools stop and tell you what's wrong instead of falling back silently.

**Precedence (D3):**

1. Workspace `.chamba/parche.json` — authoritative
2. `CHAMBA_OBSIDIAN_VAULT_PATH` env var (discovery only, no binding)
3. Global `~/.chamba/parche.json` — authoritative
4. Obsidian auto-detection (no binding)

**Joining with a workspace scope:**

```sh
# Inside a workspace directory:
npx @chamba/mcp vault join K7QX-M2RP \
  --name "Joys" --email "joys@example.com" \
  --scope workspace \
  --yes
```

If `--scope` is omitted inside a workspace, a TTY prompt asks which scope to use.
Without a TTY and without `--scope`, the command exits with code 1.

**`autoSync` in the binding file (`.chamba/parche.json`):**

```json
{
  "version": 1,
  "server": "https://parche.example.com",
  "slug": "my-team",
  "vaultDir": "vault",
  "autoSync": { "enabled": true, "pullTtlMin": 5 }
}
```

`vaultDir` is relative to the workspace root. Set `autoSync.enabled: false` to disable
background syncs without losing the binding.

**Unlinking:**

```sh
npx @chamba/mcp vault unlink --scope workspace   # remove workspace binding
npx @chamba/mcp vault unlink --scope global      # remove global binding
```

Credentials and vault files are never touched — only the `.chamba/parche.json` file is deleted.

**`CHAMBA_WORKSPACE_ROOT` env var:**

Inject the workspace root explicitly (useful in CI or when the MCP server is started from
outside the workspace):

```json
"env": { "CHAMBA_WORKSPACE_ROOT": "/path/to/workspace" }
```

When set, it wins over cwd-based detection. The `chamba_doctor` and `chamba_vault_status`
tools report the workspace root and whether it came from `env` or `cwd`.

---

### Español

Cada workspace (cualquier directorio que contenga `.chamba/workspace.md`) puede tener su
propio **vínculo de parche** en `.chamba/parche.json`. Ese vínculo tiene prioridad sobre
todo lo demás — incluyendo `CHAMBA_OBSIDIAN_VAULT_PATH` y el global `~/.chamba/parche.json`
— y es **autoritativo**: si existe pero no se puede sincronizar, las tools se detienen y
explican el problema, sin caer silenciosamente a otra opción.

**Precedencia (D3):**

1. Workspace `.chamba/parche.json` — autoritativo
2. Variable de entorno `CHAMBA_OBSIDIAN_VAULT_PATH` (solo descubrimiento)
3. Global `~/.chamba/parche.json` — autoritativo
4. Auto-detección de Obsidian

**Unirse con scope workspace:**

```sh
# Dentro de un directorio workspace:
npx @chamba/mcp vault join K7QX-M2RP \
  --name "Joys" --email "joys@example.com" \
  --scope workspace \
  --yes
```

Si se omite `--scope` dentro de un workspace, se hace prompt por TTY para elegir.
Sin TTY y sin `--scope`, el comando sale con código 1.

**`autoSync` en el archivo de vínculo (`.chamba/parche.json`):**

```json
{
  "version": 1,
  "server": "https://parche.example.com",
  "slug": "mi-equipo",
  "vaultDir": "vault",
  "autoSync": { "enabled": true, "pullTtlMin": 5 }
}
```

`vaultDir` es relativo a la raíz del workspace. Poniendo `autoSync.enabled: false` se
deshabilita la sincronización automática sin perder el vínculo.

**Desvincular:**

```sh
npx @chamba/mcp vault unlink --scope workspace   # elimina el vínculo workspace
npx @chamba/mcp vault unlink --scope global      # elimina el vínculo global
```

Las credenciales y archivos del vault nunca se tocan — solo se elimina el archivo `.chamba/parche.json`.

**Variable de entorno `CHAMBA_WORKSPACE_ROOT`:**

Inyecta el workspace root explícitamente (útil en CI o cuando el MCP server se inicia
fuera del workspace):

```json
"env": { "CHAMBA_WORKSPACE_ROOT": "/ruta/al/workspace" }
```

Cuando está presente, gana sobre la detección por cwd. Las tools `chamba_doctor` y
`chamba_vault_status` reportan el workspace root y si vino de `env` o `cwd`.

## License

MIT
