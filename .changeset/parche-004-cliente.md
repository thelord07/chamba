---
"@chamba/core": minor
"@chamba/adapters": minor
"@chamba/mcp": minor
---

PARCHE-004: cliente de parche — vault join/sync/status/leave (CLI + tools MCP) + sync automático

- `@chamba/core`: nuevos ports `HttpPort` / `HashPort`; métodos `readBytes` / `writeBytes` / `rename` / `stat` en `FilesystemPort`; `vault-sync/runner` (scanLocal + syncOnce + joinOnce), `vault-sync/credentials`, `vault-sync/state-store`, `vault-sync/server-url`, `vault-sync/parche-client`; `memory/FilesystemMemoryStore` con `opts.dir` configurable; fakes `FakeParche` / `FakeHash` exportados desde `@chamba/core`.
- `@chamba/adapters`: implementaciones `NodeHttp` / `NodeHash`; extensión de `NodeFilesystem` con `readBytes` / `writeBytes` (atómico, mode 0600) / `rename` / `stat`.
- `@chamba/mcp`: CLI `vault join|sync|status|leave`; tools MCP `chamba_vault_join` / `chamba_vault_sync` / `chamba_parche_status`; auto-sync no-bloqueante (presupuesto 10 s) en `summarize_to_vault` / `load_context` / `remember` / `recall`; memorias de grupo en `<vault>/memory/` (gate decision 4); pino `redact` para el token; README con sección parche.
