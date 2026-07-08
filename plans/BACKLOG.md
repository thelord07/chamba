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

## ✳️ Post-0.10.0 — sin publicar todavía (próximo release)
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
- **doctor multi-repo fix (pendiente)** — ver 🐛 abajo; entra en el mismo release.

---

## 🔜 Tier 2 — próximo (target 0.11.0)

### A. Backup/rollback del instalador (claude-extras)
- Snapshot de `~/.claude.json` + assets instalados **antes** de `install --force` y `uninstall`.
- Nuevo `chamba-install rollback` que restaura el último snapshot.
- Retención de N snapshots + "pin"; dedup por hash.
- Encaja con "nunca destruir en silencio".
- Archivos: `packages/claude-extras/src/installer.ts` (+ snapshot store), `cli.ts` (verbo `rollback`), tests.

### B. Aceptación en Given/When/Then (planner + reviewer)
- El `planner` emite los criterios del `## QA plan` como **Given/When/Then**.
- El reviewer heurístico (sin LLM) valida que cada criterio sea **testeable** (tiene G/W/T) → si no, warning.
- Aprieta el loop de QA de 0.7.0.
- Archivos: `packages/claude-extras/assets/agents/planner.md`, `packages/core/src/plan/validator.ts`, tests.

---

## 🔭 Tier 3 — después

### 1. Ticket "design-aware" (Figma MCP)  ← idea nueva de esta conversación
Mismo patrón que QA/Playwright: **detectar → usar si está → degradar a screenshots**. chamba no llama a Figma; el modelo del editor sí.
- **Planner**: sección `## Design` cuando el ticket es visual (link Figma/screenshots, frames/nodes, breakpoints, estados).
- **Implementer**: si hay Figma MCP, saca tokens/medidas/tipografía exactas; si no, trabaja de screenshots + specs.
- **QA**: check visual — **Figma MCP + Playwright MCP combinados** (Playwright renderiza, Figma da la referencia, reporta PASS/FAIL visual). Si no hay MCP, contra screenshots.
- Refuerzo no-LLM opcional: `validator.ts` → si el ticket es front y trae link `figma.com` pero el plan no capturó diseño → warning `missing-design-capture` (espíritu de `missing-qa-plan`).
- Honestidad: venderlo como "design-accurate / verificado contra Figma", no "pixel perfect mágico".
- Archivos: `ticket.md` (preámbulo degrade), `planner.md`, `implementer.md`, `qa.md`, `validator.ts`.

### 2. Registry de skills/playbooks (index-first)
- `.chamba/skills/*.md` indexados `{name, description, scope, path}`; el modelo matchea tarea→description y lee el `SKILL.md` completo (tokens baratos, cero LLM del lado de chamba).
- Enviarlo **vacío**; la comunidad lo llena. Ojo scope creep → opt-in.

### 3. Más editores (examples/)
- Guías de setup para Gemini CLI, Codex, Kiro, Zed, JetBrains, Trae. Como es MCP-first, "soportar" = un snippet de config. Barato, agranda el TAM.

### 4. Calidad de release (proceso)
- **Golden tests** del reviewer/plan (snapshot de veredictos heurísticos) → cambios de comportamiento visibles en el diff.
- **`doctor` como gate** pre-release + en CI.
- Modo **no-interactivo `--yes`** en instalador/wizard (adopción en CI/scripts).
- Doc de **checklist de release**.

---

## 🐛 Fixes / mejoras encontradas

### Doctor: falso-positivo en workspaces multi-repo
Encontrado dogfooding en **finalis**. El check "Git repo" corre `git rev-parse` sólo en el `cwd`; en un workspace multi-repo (el top-level es contenedor, los sub-repos son git) warnea de más.
- Fix: usar `detectGitRepos` (ya existe en core) y reportar *"N git repos found (multi-repo workspace)"* en vez de ⚠.
- Es una mejora chica al feature que acabamos de shippear (0.10.0). Buen candidato a un 0.10.1.

---

## 💭 Parkeado / "lo que teníamos antes"
- **Service registry + drift detection** (roadmap original #6): mapear servicios/contratos entre repos y detectar drift.
- **V2 del README**: búsqueda semántica del vault, MCP sampling, más bases de conocimiento.
- **Landing + docs**: seguir actualizando fase por fase (regla del proyecto).

---

## Orden sugerido
1. **0.10.1** — fix doctor multi-repo (chico, ya lo entendemos).
2. **0.11.0** — Tier 2 (rollback + G/W/T).
3. **0.12.0+** — Tier 3, arrancando por *ticket design-aware (Figma)* que es el de más valor para el día a día.
