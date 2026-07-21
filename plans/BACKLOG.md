# chamba — Backlog / cosas por hacer

> Índice vivo de lo pendiente. Ideas robadas de gentle-ai + surgidas dogfooding.
> Todo respeta los principios: **cero LLM en chamba**, editor-agnóstico, no-destructivo.
> Leyenda: ✅ hecho · 🔜 próximo · 🔭 después · 🐛 fix · 💭 parkeado

---

## ✅ Tier 1 — HECHO (0.10.0, publicado)
Detalle en [tier1-doctor-memory-presets.md](tier1-doctor-memory-presets.md).
- **`chamba_doctor`** — health check (tool MCP + `npx @chamba/mcp doctor`).
- **Memoria index-first + dedup** — `INDEX.md` por carpeta + agrupamiento `proyectos/<owner-repo>/`.
- **Presets** — `config preset <budget|balanced|quality|fast>`.

---

## ✅ 0.11.0 / 0.11.1 — PUBLICADO
- **qa como co-piloto (HECHO)** — el agente `qa` ya no crea usuarios de identity
  provider (Auth0/Firebase/Cognito → te los pide/confirma); el **login siempre es
  humano** (abre el browser y pausa, no automatiza credenciales); multi-user →
  re-login por actor; sigue aplicando el data-seed local. Archivos: `qa.md`,
  `planner.md`, comandos `ticket.md` + `qa.md`. Changeset: `qa-copilot` (patch).
- **Detección de auth en el workspace (HECHO)** — `workspace_init` escanea deps y
  escribe una sección `## Auth` (Auth0/Firebase/Cognito/Clerk/Supabase/…) con
  provider + packages + proyectos; si no detecta nada, te pide documentarlo. Es la
  **base** para el qa co-piloto y el planner. Archivos: `scanner.ts`, `workspace.ts`,
  tests. Changeset: `workspace-auth` (minor → el próximo release sería **0.11.0**).
- **Seguridad: ningún agente borra sin preguntar (HECHO)** — tras un QA que pudo
  borrar la DB local: regla dura en los 5 agentes (nunca drop/reset/truncate DB,
  borrar archivos/datos, force-push, borrar ramas sin confirmación → STOP y pregunta);
  seed del qa additive/no-destructivo; el hook `PreToolUse-warn-destructive.sh` ahora
  también pregunta ante wipes de DB (`prisma migrate reset`, `--force-reset`,
  `DROP`/`TRUNCATE`, `db:reset`…) y más borrados fs/git/docker. Changeset:
  `never-delete-without-asking` (patch).
- **qa: evidencia + reuso de users (HECHO, 0.11.1)** — screenshots numeradas por criterio
  (PASS/FAIL) en carpeta categorizada **fuera de todo repo git**; "discover before you
  create" (inventaria users/roles/RBAC existentes y los reusa en vez de crear cuentas
  descartables). Archivos: `qa.md`, comandos `ticket.md` + `qa.md`.

---

## ✅ 0.12.0 — PUBLICADO
- **Paralelismo consciente de recursos (RAM/CPU)** — ver Tier 2 · C abajo (detalle completo).
- **doctor multi-repo fix** — ver 🐛 abajo.

---

## ✅ Tier 2 — HECHO (0.13.0)
Detalle en [tier2-rollback-gwt.md](tier2-rollback-gwt.md).

### A. Backup/rollback del instalador — ✅ HECHO (0.13.0)
- `install --force` y `uninstall` hacen **snapshot** de `~/.claude.json` + assets bajo
  `~/.chamba/backups/` antes de tocar nada. Nuevo `chamba-install rollback`
  (`--list` / `<id>` / `--pin`). Dedup por hash (FNV-1a), retención newest-5 + pineados.
  `SnapshotStore` puro sobre `FilesystemPort`.

### B. Aceptación en Given/When/Then — ✅ HECHO (0.13.0)
- El `planner` emite los criterios del `## QA plan` como **Given/When/Then**
  (Dado/Cuando/Entonces); el reviewer heurístico (sin LLM) warnea `qa-criteria-not-testable`
  si el QA plan no los estructura así.

### C. Paralelismo consciente de recursos (RAM/CPU) — ✅ HECHO (0.12.0)
Detalle en [resource-aware-parallelism.md](resource-aware-parallelism.md).
- Tool determinista `chamba_resource_budget` (mide vía `node:os`, aritmética pura, cero LLM);
  `create_worktrees` devuelve `recommendedParallelism`; `/ticket` y `/orq` corren por **oleadas**.
  Cap en `worktrees.maxParallel` / `worktrees.perWorkerMemMB`. Doctor suma línea `system`.

---

## 🔭 Tier 3 — en curso (0.14.0+)

### 0.5. Design sources enlazables + preferencia de arquitectura — ✅ HECHO (0.18.0)
Detalle en [design-sources.md](design-sources.md).
- Registro `.chamba/design/*.md` que **enlaza** fuentes de diseño externas (carpeta de mockups,
  Figma, prompt/spec, o el zip/standalone de Claude Code). Tool `chamba_load_design` (determinista)
  las resuelve por ticket; `chamba_design_prefs` guarda la arquitectura de UI (Atomic Design / FSD /
  … , web y móvil por separado): el planner pregunta una vez y reusa. Cablea planner/implementer/qa
  + comando `/design`. chamba enlaza y lee; el modelo del editor hace lo visual.

### 0. QA móvil (React Native / Expo) — ✅ HECHO (0.16.0)
Detalle en [mobile-qa-expo.md](mobile-qa-expo.md).
- El scanner detecta RN/Expo (managed/bare, EAS, dev-client, e2e Detox/Maestro/Appium) → sección
  `## Mobile`. Nuevo tool `chamba_qa_capabilities` (read-only, cero LLM): enumera simuladores/
  emuladores disponibles (`xcrun simctl` / `adb` / `emulator -list-avds`) + tooling E2E. El `qa`
  gana el modo móvil (usa el MCP de device del editor si está; si no, co-pilotea en simulador/
  emulador o Expo Go). chamba detecta y lista; el device lo maneja el MCP/terminal, no chamba.

### 1. Ticket "design-aware" (Figma MCP) — ✅ HECHO (0.14.0)
Detalle en [tier3-design-aware.md](tier3-design-aware.md).
- `planner` emite `## Design` para tickets visuales; `implementer` saca tokens/medidas de un
  Figma MCP si está (si no, screenshots); `qa` suma check visual contra la referencia;
  reviewer heurístico warnea `missing-design-capture` (link figma sin `## Design`). Honesto:
  design-accurate, no "pixel perfect". chamba no llama a Figma; el MCP del editor sí.

### 2. Registry de skills/playbooks (index-first) — ✅ HECHO (0.15.0)
Detalle en [tier3-skills-registry.md](tier3-skills-registry.md).
- Tool `chamba_load_skills`: `.chamba/skills/*.md` (proyecto + `~/.chamba/skills`) con frontmatter
  `{name, description, scope?}`; matchea tarea↔description (index-first, cero LLM), devuelve las
  relevantes con cuerpo + el catálogo. Wired en `/ticket` y `/orq`. Vacío/opt-in.

### 3. Más editores (examples/) — ✅ HECHO (0.17.0)
Detalle en [tier3-more-editors.md](tier3-more-editors.md).
- Guías de setup para Gemini CLI, Codex, Kiro, Zed, JetBrains, Trae + detección de sus archivos
  de reglas (`GEMINI.md`, `.junie/guidelines.md`, `.kiro/steering`, `.rules`). MCP-first: "soportar"
  = un snippet de config. Barato, agranda el TAM.

### 4. Calidad de release (proceso) — ✅ HECHO (0.19.0)
Detalle en [tier3-release-quality.md](tier3-release-quality.md).
- **Golden tests** del reviewer/plan (snapshot de veredictos heurísticos) → cambios de comportamiento visibles en el diff.
- **`doctor` como gate** en CI (el CLI ya sale con código 1 si `!healthy`).
- Modo **no-interactivo `--yes`** en el instalador (alias de `--defaults`/no-TTY, para CI/scripts).
- Doc de **checklist de release** (`RELEASING.md`).

---

## 🐛 Fixes / mejoras encontradas

### Doctor: falso-positivo en workspaces multi-repo — ✅ HECHO (0.12.0)
Encontrado dogfooding en **finalis**. El check "Git repo" corría `git rev-parse` sólo en el `cwd`; en un workspace multi-repo (el top-level es contenedor, los sub-repos son git) warneaba de más.
- Fix: cuando el `cwd` no es work tree, usa `detectGitRepos` y reporta *"multi-repo workspace — N git repos"* (ok) en vez de ⚠; salta el check de worktrees en el contenedor.

---

## 💭 Parkeado / "lo que teníamos antes"
- **Service registry + drift detection** (roadmap original #6): mapear servicios/contratos entre repos y detectar drift.
- **V2 del README**: búsqueda semántica del vault, MCP sampling, más bases de conocimiento.
- **Landing + docs**: seguir actualizando fase por fase (regla del proyecto).

---

## Estado de releases
- ✅ **0.10.0** — Tier 1: doctor, memoria index-first, presets.
- ✅ **0.11.0** — auth detection, qa co-piloto, delete-guard.
- ✅ **0.11.1** — qa: evidencia con screenshots + reuso de users.
- ✅ **0.12.0** — paralelismo consciente de recursos + fix doctor multi-repo.
- ✅ **0.13.0** — Tier 2: rollback del instalador + aceptación Given/When/Then.
- ✅ **0.14.0** — Tier 3 #1: ticket design-aware (Figma).
- ✅ **0.15.0** — Tier 3 #2: registry de skills/playbooks (index-first).
- ✅ **0.16.0** — Tier 3 #0: QA móvil (React Native / Expo) + `chamba_qa_capabilities`.
- ✅ **0.17.0** — Tier 3 #3: más editores (Gemini CLI, Codex, JetBrains, Trae, Zed, Kiro).
- ✅ **0.18.0** — Tier 3 #0.5: design sources enlazables + preferencia de arquitectura de UI.
- ✅ **0.19.0** — Tier 3 #4: calidad de release (golden tests, doctor gate en CI, `--yes`, RELEASING.md).

## Orden sugerido (lo que sigue)
1. **1.0.0** — Tier 3 completo. Pulido y estabilización: revisar la superficie de tools, endurecer
   docs, y taggear el primer estable.
