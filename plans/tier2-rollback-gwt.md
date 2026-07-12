# Plan — Tier 2 (0.13.0): rollback del instalador + aceptación Given/When/Then

> Estado: ✅ Completada — 0.13.0 · Respeta los 10 principios (cero LLM).

## A. Backup/rollback del instalador (claude-extras)

**Problema:** `install --force` sobrescribe y `uninstall` borra assets + toca `~/.claude.json`.
Hoy no hay red de seguridad. Encaja con "nunca destruir en silencio".

**Diseño (testeable, sobre `FilesystemPort`, sin `node:crypto`):**
- **NUEVO `src/snapshot-store.ts`** — `SnapshotStore { fs, dir, now }`:
  - `save(files, reason) → { meta, deduped }` — un snapshot = un `manifest.json`
    (`{ id, createdAt, hash, reason, pinned, files: { <relpath>: <content> } }`) en
    `<dir>/<id>/manifest.json`. **Dedup**: si el último snapshot tiene el mismo `hash`
    (FNV-1a puro del mapa de archivos canónico), no escribe y devuelve `deduped:true`.
  - `list() → SnapshotMeta[]` (más nuevo primero). `load(id?) → { meta, files }` (id
    default = el más nuevo). `prune(keep) → removedIds` (conserva los `keep` más nuevos
    sin pin + todos los pineados). `pin(id)`.
- **`installer.ts`** — `SnapshotStore` opcional en `InstallerOptions`:
  - `snapshot(reason)` — junta el estado actual (`.claude.json` + cada asset instalado en
    `<claudeDir>/<cat>/<name>` que exista) y llama `store.save` + `store.prune(keep)`.
  - Llamar `snapshot('install --force')` al inicio de `install({force:true})` y
    `snapshot('uninstall')` al inicio de `uninstall()` — solo si hay store. `install` sin
    force NO snapshotea (solo agrega, no destruye).
  - `rollback(id?) → { restored, mcpRestored }` — carga snapshot, reescribe cada archivo
    (incluido `.claude.json`).
- **`cli.ts`** — verbo `rollback`: `rollback` (restaura el último), `rollback --list`,
  `rollback <id>`, `rollback --pin <id>`. Wire del store con dir
  `~/.chamba/backups/claude-extras` y `now = () => new Date().toISOString()...`. Actualizar
  USAGE. Snapshot antes de `install --force`/`uninstall` en el flujo del CLI.
- **Tests** `snapshot-store.test.ts` (save/dedup/list/load/prune/pin) + casos en
  `installer.test.ts` (force snapshotea, uninstall snapshotea, rollback restaura).

**Retención:** default `keep=5` sin pin + todos los pineados. Dedup por hash.

## B. Aceptación en Given/When/Then (planner + reviewer heurístico)

**Problema:** los criterios del `## QA plan` son prosa libre → ambiguos de testear.

- **`validator.ts`** — check #10 (NO-LLM, warning): si existe una sección QA
  (`qa plan`/`qa`/`acceptance test`/`manual test`) pero su texto **no** tiene estructura
  Given/When/Then (EN: given+when+then; ES: dado+cuando+entonces) → warning
  `qa-criteria-not-testable` + sugerencia. Conservador: solo cuando ya hay QA plan.
- **`validator.test.ts`** — QA plan con G/W/T → sin warning; QA plan en prosa → warning;
  sin QA plan → sin warning (no lo fuerza en backend).
- **`planner.md`** — al escribir el `## QA plan`, emitir cada criterio de aceptación como
  **Given / When / Then** (Dado / Cuando / Entonces): precondición → acción → resultado
  observable. Así el qa los recorre sin ambigüedad.

## Verificación
1. `pnpm -r build && pnpm -r test` verde (nuevos tests + conteos del installer sin cambio).
2. `SnapshotStore`: save dos veces igual → segundo `deduped`; prune respeta pin.
3. `install --force` deja un snapshot; `rollback` restaura el estado previo (incl. `.claude.json`).
4. `validatePlan`: QA plan en prosa → `qa-criteria-not-testable`; con G/W/T → limpio.

## Release
Minor → changeset `@chamba/core` (validator) + `@chamba/claude-extras` (rollback + planner)
→ **0.13.0** (lockstep bumpea los 4).
