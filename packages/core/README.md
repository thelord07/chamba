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
| `pushRequestSchema`, `pushResponseSchema` | Optimistic push schemas (≥1, ≤500 changes, unique paths) |
| `joinRequestSchema`, `joinResponseSchema` | Invite-code join (normalizes to uppercase) |
| `deviceAuthStartResponseSchema`, `deviceAuthPollResponseSchema` | Device flow auth |
| `isSyncable(path)` | Returns true iff path should be synced (denylist + extension allowlist) |
| `conflictCopyPath(path, author, existing)` | D3 conflict copy name: `dir/stem (conflicto author[ N]).ext` |
| `addConflictFrontmatter(md, meta)` | Upsert `conflict_of`/`conflict_base` in YAML frontmatter |
| `readConflictMeta(md)` | Read back `{ conflictOf, conflictBase }` or null |
| `planPush(state, local)` | Compute push entries (new/modified/deleted) |
| `planPull(state, local, remote, opts)` | Compute pull actions (write/delete/conflict/noop) |
| `applyPushResults(state, request, response)` | Advance SyncState after push; only `ok` results advance |
| `ROLE_PERMISSIONS`, `can(role, action, target?)` | Permission table + helper for 4 roles × 7 actions |

### Roles

| Role | Permissions |
|---|---|
| `owner` | All actions, including `delete_group`. Unique per group. |
| `admin` | `read`, `sync`, `write`, `invite`, `revoke`, `change_role` — but cannot target `owner`. |
| `editor` | `read`, `sync`, `write`. |
| `reader` | `read`, `sync` (pull-only). |

### planPull signature

```ts
planPull(
  state: SyncState,
  local: LocalSnapshot,
  remote: ChangeEntry[],
  opts: { localAuthor: string },   // extensible object
): PullPlan
```

**Push before pull**: rule #4 (local deleted, remote modified → write) can resurrect a
locally-deleted file if you pull before pushing. Always push first, then pull. This is
intentional — content is never lost.

## License

MIT
