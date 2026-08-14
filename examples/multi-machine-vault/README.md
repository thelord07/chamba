# chamba across machines — share the vault

Run chamba on **two (or more) machines at once**, sharing one brain. Machine A resolves a
plan while machine B implements another repo; both read the same context, memory and plans.
This lifts the single-machine RAM ceiling and cuts the waiting — chamba does more in
parallel.

chamba has **no server** and doesn't coordinate the machines. What they share is the
**vault** (context + memory + plans + summaries). You sync the vault **folder** and point
every machine at it. That's the whole trick.

## 1. Know which vault chamba uses

chamba resolves the vault in this order:

1. **`CHAMBA_OBSIDIAN_VAULT_PATH`** (env on the MCP server) — **wins over everything**. The
   explicit knob.
2. Otherwise it **detects** a `.obsidian/` folder, checking the current project (`cwd`)
   **first**, then `~/Documents`, `~/Notes`, `~/Obsidian`, `~/.chamba/vault`, home.
3. Otherwise `chamba_workspace_init` bootstraps a **global** vault at `~/.chamba/vault`.

Find the active path anytime:

```bash
npx @chamba/mcp doctor
# → ✓ Obsidian vault — /Users/you/… (CHAMBA_OBSIDIAN_VAULT_PATH | autodetected, N notes)
```

## 2. Global vault vs per-project vault

- **Global** (`~/.chamba/vault`): one shared brain for everything. Simplest; good when both
  machines hop across many projects.
- **Per-project**: a vault scoped to one project/workspace. Two ways to get it:
  - **Env (explicit):** set `CHAMBA_OBSIDIAN_VAULT_PATH` in the **project's** MCP config
    (below). Wins, always.
  - **Detection (zero-config):** put the vault's `.obsidian/` at the **project root** and set
    **no** env — chamba checks `cwd` first, so it uses the project vault automatically.

### Point chamba at a specific vault (per editor)

Use an **absolute path** (`~` isn't expanded in MCP env). A **project-scoped** config file
lives in the project root, so it only applies there — that's how you get "this project's
vault, not the global one". Restart the editor after editing.

**Claude Code** — project `.mcp.json` (or global `~/.claude.json`):

```json
{ "mcpServers": { "chamba": { "command": "npx", "args": ["-y", "@chamba/mcp"],
  "env": { "CHAMBA_OBSIDIAN_VAULT_PATH": "/Users/you/Sync/chamba-vault" } } } }
```

**Cursor** — project `.cursor/mcp.json`: same shape as above.

**OpenCode** — `opencode.json` (note: `environment`, not `env`; command is an array):

```json
{ "mcp": { "chamba": { "type": "local", "command": ["npx", "-y", "@chamba/mcp"],
  "environment": { "CHAMBA_OBSIDIAN_VAULT_PATH": "/Users/you/Sync/chamba-vault" }, "enabled": true } } }
```

> **Avoid a duplicate registration.** If chamba is registered **both** globally
> (`~/.claude.json`) **and** per-project with a different vault, the editor silently picks
> one — and it may not be the one you meant. `chamba doctor`'s **MCP registration** check
> warns you. Keep a single `chamba` entry per project (prefer the project one), or make them
> identical.

## 3. Sync the vault folder across machines

The vault is plain markdown + JSON — sync the **folder**, and point every machine's
`CHAMBA_OBSIDIAN_VAULT_PATH` at its local copy. Works the same for a **global** or a
**per-project** vault; only the path differs.

| Option | Real-time? | Notes |
|---|---|---|
| **Syncthing** ⭐ | Yes (peer-to-peer, continuous) | Best fit: no cloud lag, no file eviction, free. Sync **just the vault folder**. |
| **iCloud / Dropbox** | Eventual (seconds–minutes) | Zero-install if you're already in it. Turn **off "Optimize Mac Storage"** for the folder — iCloud evicts files to the cloud and chamba can then read them empty. Expect occasional `conflict` copies. |
| **Private git repo (vault only)** | On commit/pull | Best durability + history. Not real-time unless you add an auto-commit/pull watcher. A **dedicated** repo — never the code repo. |

**Keep vault-sync separate from code-sync.** If the vault lives inside a code repo, keep it
gitignored (chamba does this automatically) and sync it as files with the tool above — don't
commit it, and don't hand a whole project (with its `.git`) to Syncthing.

### Setup (any tool)

1. Put the vault in a synced folder (e.g. `~/Sync/chamba-vault`) on machine A. If you already
   have `~/.chamba/vault`, move it there once.
2. Let it sync to machine B.
3. On **both** machines, set `CHAMBA_OBSIDIAN_VAULT_PATH` to that path (global or per-project
   config, per section 2).
4. `chamba doctor` on each → the `Obsidian vault —` line should show the synced path and the
   note count.

## 4. The one concurrency gotcha

Two machines writing the **same file** at once can conflict. But chamba's writes are mostly
**additive and partitioned**:

- `summarize_to_vault` → a **new** note per run (unique name).
- `save_plan` → one file per ticket.
- `remember` → one file per key.

The only real collision point is the per-folder **`INDEX.md`** (one machine can overwrite the
other's index update) — and that's regenerable, low-impact. So **eventual sync is fine**; you
don't need transactional sync. To minimize it, avoid both machines summarizing the **same**
project in the same second — working different repos/projects keeps them in separate
`proyectos/<owner-repo>/` folders, so they never overlap.

---

**TL;DR:** the vault is chamba's shared brain. Sync its folder (Syncthing for real-time),
point `CHAMBA_OBSIDIAN_VAULT_PATH` at it on every machine (globally or per-project), and run
chamba in parallel — the RAM ceiling and the waiting both go away.
