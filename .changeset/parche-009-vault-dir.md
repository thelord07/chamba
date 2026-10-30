---
'@chamba/core': minor
'@chamba/adapters': minor
'@chamba/mcp': minor
---

**PARCHE-009: vault en ruta propia (`--dir`) + adopción segura**

- `vault join --dir <path>` y `vault link <slug> --dir <path>` permiten usar cualquier carpeta como vault.
- Gate de adopción universal: cuando la carpeta tiene archivos sincronizables, se muestra un resumen y se requiere `--yes` (o confirmación TTY) antes de subir nada.
- `pendingAdoption` en el estado bloquea `vault sync`, autosync y la tool `chamba_vault_sync` hasta confirmar.
- `VaultDirMissingError`: si la carpeta guardada ya no existe, el sync falla con mensaje claro sugiriendo `vault link`.
- `SYSTEM_DIRS` ampliada (macOS, Linux, Windows) — match exacto, subcarpetas permitidas.
- `realpath` en `FilesystemPort` (lexical en tests, Node `fs.realpath` en producción con tolerancia ENOENT).
- `resolveVaultDir` es la única construcción del path default `~/.chamba/vaults/<slug>`.
- `ensureVaultGitignored` acepta parámetro `extra` para añadir `.chamba-sync/` solo cuando el vault está en un repo.
- Tool `chamba_vault_join`: nuevos campos `dir?` y `confirmUpload?`; si `in_repo` sin `--allow-in-repo`, devuelve `isError` sugiriendo la CLI.
- `active-vault.ts`: guard `realpath` evita autosync de dirs abandonados tras `vault link`.
- README: sección bilingüe "Usar tu propio vault / Use your own vault".
