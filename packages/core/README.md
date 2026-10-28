# @chamba/core

Pure core logic for [chamba](https://github.com/thelord07/chamba): workspace scanner,
plan generator + heuristic reviewer, git worktree manager, Obsidian context/vault
writer, and a filesystem memory store.

- **No Node APIs directly** — all OS access goes through ports (`FilesystemPort`,
  `ProcessPort`, `ClockPort`), so it's testable and runtime-agnostic.
- **No LLM** — chamba never calls a model.
- Node implementations of the ports live in
  [`@chamba/adapters`](https://www.npmjs.com/package/@chamba/adapters).

Most users want the [`@chamba/mcp`](https://www.npmjs.com/package/@chamba/mcp) server,
not this library directly.

## vault-sync (protocolo de parche)

Pure schemas and logic for syncing an Obsidian-compatible vault between group members.
No network, no crypto, no fs — hashes arrive pre-computed from the adapter.

### Main exports

| Export | Description |
|---|---|
| `hashSchema`, `vaultPathSchema`, `roleSchema` | Zod primitives (NFC-normalized paths, sha256 hashes, 4-role enum) |
| `changeEntrySchema`, `changesResponseSchema` | Remote change feed schemas |
| `pushRequestSchema`, `pushResponseSchema` | Optimistic push schemas (≥1, ≤500 changes; no exact duplicate path; no two live entries sharing a `pathKey`) |
| `joinRequestSchema`, `joinResponseSchema` | Invite-code join (normalizes to uppercase) |
| `deviceAuthStartResponseSchema`, `deviceAuthPollResponseSchema` | Device flow auth |
| `isSyncable(path)` | Returns true iff path should be synced (denylist + extension allowlist) |
| `pathKey(path)` | Canonical key: `path.normalize('NFC').toLowerCase()` — case-insensitive identity for macOS/Windows FS |
| `findCaseCollisions(paths)` | Groups of paths that collide under `pathKey` (≥2 distinct paths per group); for server/client validation |
| `conflictCopyPath(path, author, existing)` | D3 conflict copy name: `dir/stem (conflicto author[ N]).ext`; occupancy checked case-insensitively via `pathKey` |
| `addConflictFrontmatter(md, meta)` | Upsert `conflict_of`/`conflict_base` in YAML frontmatter |
| `readConflictMeta(md)` | Read back `{ conflictOf, conflictBase }` or null |
| `planPush(state, local)` | Compute push entries (new/modified/deleted); deletes first, then the rest, by path |
| `planPull(state, local, remote, opts)` | Compute pull actions (write/delete/conflict/noop) sorted by (rank, path) — see Action order below |
| `applyPullPlan(state, plan)` | Derive new SyncState from a pull plan (pure, no mutation); closes the false-conflict gap after a converged pull |
| `applyPushResults(state, request, response)` | Advance SyncState after push; only `ok` results advance |
| `ROLE_PERMISSIONS`, `can(role, action, target?)` | Permission table + helper for 4 roles × 7 actions |

### Roles

| Role | Permissions |
|---|---|
| `owner` | All actions, including `delete_group`. Unique per group. |
| `admin` | `read`, `sync`, `write`, `invite`, `revoke`, `change_role` — but cannot target `owner`. |
| `editor` | `read`, `sync`, `write`. |
| `reader` | `read`, `sync` (pull-only). |

### Case-insensitive path identity

Vault paths are compared case-insensitively because macOS and Windows filesystems are
case-insensitive. `pathKey(p)` is the canonical form used everywhere:

```ts
pathKey('Nota.md')       // → 'nota.md'
pathKey('NOTAS/A.MD')    // → 'notas/a.md'
```

`pushRequestSchema` rejects a push when the same exact path appears twice, or when two
**live** entries (`newHash !== null`) share a `pathKey` (e.g. `Nota.md → H1` + `nota.md → H2`).
A delete plus a live entry with the same `pathKey` is a casing rename and is valid:

```ts
planPush({ cursor: 0, files: { 'Nota.md': { syncedHash: S1 } } }, { 'nota.md': S1 })
// → [{ path: 'Nota.md', baseHash: S1, newHash: null },
//    { path: 'nota.md', baseHash: null, newHash: S1 }]   // accepted by pushRequestSchema
```

`planPush` returns deletes (`newHash: null`) first, then the rest, by path within each
group. The server applies a push in the order received, so the old name is removed
before the new one is created.

`vaultPathSchema` also rejects any path segment that starts with `.chamba-sync`
regardless of case (`.Chamba-Sync/…` fails).

`findCaseCollisions(['Nota.md', 'nota.md', 'b.md'])` returns `[['Nota.md', 'nota.md']]`.

### planPull signature and action order

```ts
planPull(
  state: SyncState,
  local: LocalSnapshot,
  remote: ChangeEntry[],
  opts: { localAuthor: string },   // extensible object
): PullPlan
```

`planPull` returns actions sorted by **(rank, path)**:

| Rank | Action type | Reason |
|---|---|---|
| 0 | `conflict` | Write local copy first, then apply remote at path |
| 1 | `delete` | Remove before any write that may share the same case-folded name |
| 2 | `write`, `noop` | Safe once conflicts and deletes are done |

This order is required on case-insensitive FS. A rename that only changes case
arrives as `delete OldCase.md` + `write newcase.md`; executing write→delete on a
case-insensitive FS would silently delete the freshly written file.

The adapter executes conflict actions in two steps:

1. Write `localHash` to `copyPath` (the local version is preserved there).
2. If `remoteHash !== null`: write `remoteHash` to `path`. Otherwise delete `path`.

### applyPullPlan

```ts
applyPullPlan(state: SyncState, plan: PullPlan): SyncState
```

Derives a new `SyncState` from a pull plan without mutating the input:

- `write`    → `files[path] = { syncedHash: hash }`
- `delete`   → `files[path] = { syncedHash: null }`
- `noop`     → `files[path] = { syncedHash: hash }` (convergence — closes the false-conflict gap)
- `conflict` → `files[path] = { syncedHash: remoteHash }`; `copyPath` is **not** added to state
- `cursor`   = `plan.cursor`

`copyPath` stays out of state so that the next `planPush` uploads it with `baseHash: null`
(new file) rather than treating it as a known synced path.

**Push before pull**: rule #4 (local deleted, remote modified → write) can resurrect a
locally-deleted file if you pull before pushing. Always push first, then pull. This is
intentional — content is never lost.

## License

MIT
