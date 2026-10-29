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
| `joinRequestSchema`, `joinResponseSchema` | Invite-code join: request carries `{ code, name, email, deviceLabel? }` (code normalized to uppercase; email trimmed + lowercased); response includes `user: { id, name }` and `device: { id, label }` |
| `userSchema`, `deviceSchema` | Identity objects returned by the server after a successful join or device-flow approval |
| `deviceAuthStartResponseSchema`, `deviceAuthPollResponseSchema` | Device flow auth; `approved` variant includes `user` and `device` |
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

## Vault sync client (PARCHE-004)

`@chamba/core` ships a pure-TypeScript vault sync client (no Node imports) that speaks the parche protocol. Import it from the `vault-sync/` sub-paths or directly from `@chamba/core`.

### Ports required

| Port | Method | Description |
|---|---|---|
| `HttpPort` | `request(req)` | HTTP client; `HttpRequest` carries an optional `AbortSignal`. |
| `HashPort` | `sha256(data)` | Async SHA-256 returning a lowercase hex string. |
| `FilesystemPort` | `readBytes / writeBytes / rename / stat` | Binary I/O; `writeBytes` accepts `{ mode? }` for chmod-style permissions. |
| `ClockPort` | `now() / today() / sleep?()` | Wall-clock and optional async sleep. |

### Key exports

```ts
// Ports
import type { HttpPort, HttpRequest, HttpResponse } from '@chamba/core';
import type { HashPort } from '@chamba/core';
import type { FileStat, WriteBytesOptions } from '@chamba/core';

// Sync client
import { syncOnce, joinOnce, scanLocal, CaseCollisionError } from '@chamba/core';
import { readState, writeState } from '@chamba/core';
import { CredentialsStore } from '@chamba/core';
import { ParcheClient, ParcheHttpError } from '@chamba/core';
import { parseJoinInput, resolveServerUrl } from '@chamba/core';

// Test doubles (in-memory, no Node)
import { FakeParche, FakeHash } from '@chamba/core';
```

### syncOnce

```ts
const summary = await syncOnce({ fs, http, hash, clock }, {
  vaultDir: '/path/to/vault',
  server: 'https://parche.chamba.tools',
  slug: 'my-group',
  token: 'pch_…',
  localAuthor: 'joys',
  device: 'laptop',
});
// summary: { pushed, pulled, conflicts, movedToTrash, errors }
```

Three-phase flow: **push local changes → fetch all remote pages → apply pull plan**. All remote pages are accumulated in memory before any disk write is attempted (AC13: page-N failure leaves state unchanged, no partial writes).

### joinOnce

Calls `POST /api/join`, saves the device token to `~/.chamba/credentials.json` (mode 0600), creates `.obsidian/`, and resets `state.json` with `cursor: 0` and the new `groupId` (gate decision 1: a re-join never inherits prior sync state).

### Conflict resolution

When local and remote both modified a file from the same base:

1. Local version is written to `a (conflicto joys).md` with YAML frontmatter (`conflict_of`, `conflict_base`, `conflict_at`).
2. Remote version replaces `a.md`.
3. The copy is pushed in phase 3 (`baseHash: null`, new file).

**Gate decision 2 — dedupe**: before creating a copy, the runner scans the vault for an existing copy whose frontmatter and bytes match. If found, the existing path is reused (idempotent on crash-then-retry).

### Test doubles

`FakeParche` implements `HttpPort` with full in-memory parche server semantics including `baseHash` conflict detection, blob presence checks, case-collision detection, pagination, and configurable failure knobs (`pageLimit`, `failChangesPage`, `corruptBlob`, `rejectPushBlobs`).

`FakeHash` uses `globalThis.crypto.subtle` (no Node import) and produces the same SHA-256 as `NodeHash`.

## License

MIT
