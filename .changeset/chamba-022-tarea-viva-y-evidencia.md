---
"@chamba/core": minor
"@chamba/adapters": minor
"@chamba/mcp": minor
"@chamba/claude-extras": minor
---

CHAMBA-022: ODD paso 2 — tarea viva en el vault y cierre con evidencia real, para que
"terminado" signifique verificado, no afirmado.

- **`chamba_task` (`@chamba/mcp`):** nuevo tool — `open` / `update` / `scope_change` /
  `evidence` / `verify` / `close` / `get`. Mantiene `tareas/<work_item>.md` como fuente
  de verdad del ticket (nunca vía `VaultWriter`, reindex explícito solo en `open`/`close`):
  criterios de aceptación con **texto inmutable** (la única vía a `descartado` es
  `scope_change(change='discard')`, que exige `reason` y `requestedByUser: true`),
  checklist, progreso, cambios de alcance y corridas de `verify`. Ruta `trivial` nunca
  tiene documento.
- **`verify` ejecuta de verdad (`@chamba/core` + `@chamba/adapters`):** nuevo método
  opcional `ProcessPort.run?()` con `spawn` + buffer anillo (200 líneas / 256 KiB,
  el proceso siempre termina) y tree-kill en timeout (POSIX `detached`+`SIGTERM→SIGKILL`,
  Windows `taskkill /T /F`). Los comandos salen de `repos.<nombre>.verify`, leído
  **solo** de `~/.chamba/config.json` y `<raíz-del-workspace>/.chamba/config.json` —
  nunca de un worktree ni de un repo clonado. `command` + `args` como array, nunca un
  string parseado a shell; entorno con **allowlist** por defecto (`cmd.env`/
  `inheritEnv: true` como escape hatch por comando); redacción de secretos sobre la
  salida antes de escribir cualquier evidencia.
- **Compuerta de cierre:** `chamba_task(action='close')` rechaza cerrar con un AC
  pendiente sin razón, un AC "pasa" sin evidencia, una corrida de verify fallida, un
  repo `risky` sin `verify` configurado, un AC en `falla`, o un AC descartado sin
  registro en el log de cambios de alcance. `partial: true` + `approvedByUser: true`
  exime las primeras cinco reglas (nunca la sexta) y queda registrado en el documento
  con fecha y "cierre parcial aprobado por el usuario". Al cerrar, `chamba_task_metrics`
  prefiere `testsPassed`/`delivered` medidos por `close` sobre lo que el agente declare.
- **Evidencia de QA:** `chamba_task(action='evidence', kind='qa')` copia con límites
  (2 MB/imagen, 20 MB/run, 200 archivos; el resto se enlaza, nunca se descarta).
  Config nueva `vault.syncEvidence` (default `false`): las imágenes de evidencia solo
  sincronizan al vault compartido si está en `true`, y la primera sincronización bajo
  esa opción avisa una vez que las capturas no se escanean por secretos.
- **`/ticket` y `/orq` (`@chamba/claude-extras`):** activan la fase `verify`
  (`phase_start verify` → `chamba_task(action='verify')` → `phase_end verify`) y llaman
  `open` tras clasificar, `update` por hito, `close` antes de `chamba_summarize_to_vault`
  (pegando el `closeBlockMarkdown` que devuelve), y nuevo bloque `resume` que reconcilia
  el documento contra `git status`/`git diff --stat` del worktree real. Si chamba
  rechaza el cierre, el prompt no lo rodea: resuelve lo que falta o pide cierre parcial
  con aprobación explícita. Los agentes `implementer`/`tester`/`qa` quedan al tanto de
  que no escriben al vault ni fabrican evidencia — eso es trabajo de `chamba_task`.

Sin cambios destructivos: `close` no borra nada, la evidencia que excede el presupuesto
se enlaza en vez de truncarse, y el tree-kill del timeout solo mata el árbol del proceso
que chamba lanzó.
