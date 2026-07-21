# Plan — Tier 3 · #4: Calidad de release

> Estado: ✅ Completada — 0.19.0 · Respeta los 10 principios (cero LLM).

## Idea
Endurecer el proceso de release para llegar a 1.0.0 con confianza: comportamiento del reviewer
visible en el diff, un gate de humo en CI, instalación no-interactiva para CI/scripts, y una
checklist escrita del release (que hoy vive en mi cabeza + fricciones que ya sufrimos).

## Cambios

### A. Golden tests del reviewer heurístico
- **NUEVO `packages/core/src/plan/validator.golden.test.ts`** — un corpus de planes realistas
  (backend limpio, front sin QA, móvil visual con Figma, borrado sin orphan-check, área sensible
  sin risks, one-liner, plan visual completo) → snapshot del veredicto (`issues` codes + conteos)
  con `toMatchInlineSnapshot`. Cualquier cambio en las 12 heurísticas se ve en el diff del test.

### B. `doctor` como gate en CI
- `.github/workflows/ci.yml`: paso nuevo tras Build → `node packages/mcp/dist/main.js doctor`.
  El CLI ya sale con código 1 si `!healthy` (`main.ts`). Es un **smoke gate**: valida que el
  binario compilado arranca y el entorno está sano (warnings de workspace/vault no fallan).

### C. Modo no-interactivo `--yes`
- El instalador ya salta el wizard con `--defaults` o stdin no-TTY. Agregar **`--yes`** como
  alias (convención común para scripts/CI). Extraer la decisión a un helper puro testeable
  **NUEVO `packages/claude-extras/src/install-flags.ts`** (`isNonInteractive(args, isTTY)`),
  usarlo en `cli.ts`, actualizar el USAGE. Test `install-flags.test.ts`.

### C.2. Typecheck gate verde
- Arreglados 2 errores pre-existentes de `tsc --noEmit` en `vault-index.test.ts` (index access
  bajo `noUncheckedIndexedAccess`) que dejaban rojo el paso **Typecheck** de CI. Ahora
  `pnpm -r exec tsc --noEmit` está limpio en los 4 paquetes.

### D. Checklist de release
- **NUEVO `RELEASING.md`** — el flujo completo: changeset → `changeset version` → build → test →
  biome → `doctor` → commit `chore(release): x.y.z` → push → publish → tags → GitHub Release.
  Incluye los gotchas reales: `gh` como credential helper si la key SSH tiene passphrase, y
  verificar que el tag quede sobre `main` (no huérfano tras un rebase). Documenta también el
  camino automático (changesets action en `release.yml`).

## Verificación
1. `pnpm -r build && pnpm -r test` verde (golden + install-flags).
2. `node packages/mcp/dist/main.js doctor` → exit 0 en un checkout sano.
3. `isNonInteractive` cubre `--defaults`, `--yes`, no-TTY, e interactivo.

## Release
Minor (flag `--yes` + tooling) → lockstep **0.19.0**. Cierra el Tier 3; sigue 1.0.0.
