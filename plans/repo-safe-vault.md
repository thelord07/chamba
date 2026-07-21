# Plan — Vault repo-safe (bootstrap fuera de repos + backstop)

> Estado: ✅ Completada — 0.20.0 · Respeta los 10 principios (cero LLM).

## Problema (dogfooding, encontrado por Joys)
`workspace_init`, si no encontraba vault, lo **sembraba en la raíz del workspace** — y solo
*sugería* en texto gitignorear `.obsidian/` (sin mencionar las notas ni hacerlo). Cuando esa
carpeta es (o se vuelve) un repo git, `.obsidian/`, `Workspace overview.md`, `proyectos/`,
`plans/` y `.chamba/memory/` quedaban adentro y se podían commitear. Inconsistente con la regla
de la evidencia de QA (siempre fuera del repo).

## Cambios (0.20.0)

### A. Core — helpers de seguridad del vault
- **NUEVO `packages/core/src/workspace/vault-safety.ts`**:
  - `VAULT_ARTIFACTS` — los archivos que chamba escribe en un vault (`.obsidian/`,
    `Workspace overview.md`, `proyectos/`, `plans/`, `.chamba/memory/`). NO incluye
    `.chamba/workspace.md` (contexto del proyecto, el equipo puede commitearlo).
  - `findGitRoot(fs, path)` — sube por el árbol buscando `.git` (dir o file); devuelve la raíz
    del work tree o null. Puro sobre `FilesystemPort`, sin `git`.
  - `ensureVaultGitignored(fs, repoRoot)` — appendea los patrones faltantes al `.gitignore`
    (idempotente), bajo un header de chamba. Backstop.
- Tests + export.

### B. MCP — bootstrap repo-safe
- `workspace-init.ts`: cuando no hay vault, siembra un **vault global en `~/.chamba/vault`**
  (fuera de cualquier repo), no en la raíz. Si encuentra un vault **dentro de un repo git**,
  auto-gitignorea sus artefactos y avisa que lo muevas. Descripción del tool actualizada.
- `services.ts`: `~/.chamba/vault` sumado a los searchRoots (autodetectado; un vault personal
  en Documents/Notes/Obsidian gana).

### C. Doctor
- `checkVault`: si el vault activo está **dentro de un work tree git** → `warn` con hint
  (moverlo a `~/.chamba/vault` o gitignorear). Antes siempre era `ok`.

### D. Docs
- README EN/ES: fila `chamba_workspace_init` (vault fuera del repo) + nota. Landing: fila +
  timeline + `VERSION` 0.20.0.

## Fix inmediato aplicado
- El vault de `~/Proyectos/asisten` (`.obsidian/` + `Workspace overview.md`, sin commitear) se
  movió a `~/.chamba/vault`. `asisten` conserva su `.chamba/workspace.md` (contexto).

## Release
Minor → lockstep **0.20.0**.
