---
"@chamba/core": minor
"@chamba/adapters": minor
"@chamba/mcp": minor
---

CHAMBA-015: the parche client works on Windows. `vault join/link/sync/resync/unlink` accept absolute Windows paths (`D:\workspace\vault`, `d:/…`, UNC `\\server\share\…`) via new pure local-path helpers in core (wire paths stay POSIX); drive-relative (`C:foo`) and device paths (`\\?\`, `\\.\`) are rejected with a clear error (`unsupported_path`; `unsupported_platform` is kept in the type but never produced). Windows system folders are rejected like on macOS/Linux, and path comparisons are case-insensitive on Windows. `credentials.json` gets a user-only ACL via `icacls` after every write (warning if it fails). Files whose names are invalid on Windows are skipped on pull without ever pushing a delete, retried on each sync and counted in `vault status`; pushing such a name from macOS/Linux warns. CI runs on ubuntu, windows and macOS.
