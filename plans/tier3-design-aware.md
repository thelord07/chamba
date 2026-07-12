# Plan — Tier 3 · #1: Ticket design-aware (Figma MCP)

> Estado: ✅ Completada — 0.14.0 · Respeta los 10 principios (cero LLM).

## Idea
Mismo patrón que el QA co-piloto: **detectar → usar si está → degradar a screenshots**.
chamba **NO llama a Figma**; el modelo del editor usa el Figma MCP si está configurado. Para
tickets visuales, capturamos el diseño en el plan, el implementer saca medidas/tokens exactos
si hay Figma MCP (si no, trabaja de screenshots + specs), y el qa verifica lo renderizado
contra la referencia. Honestidad: **"design-accurate / verificado contra la referencia"**, no
"pixel perfect mágico".

## Cambios (prompts editor-agnósticos + 1 heurística no-LLM)

### A. `validator.ts` — check #11 `missing-design-capture` (warning, NO-LLM)
- Si el plan trae un link `figma.com` **y** no tiene sección `## Design` → warning
  `missing-design-capture` + sugerencia. Trigger de alta precisión (como `missing-qa-plan`):
  solo cuando hay señal de diseño explícita pero el plan no la capturó.
- Tests en `validator.test.ts`: figma link sin `## Design` → warning; con `## Design` → limpio;
  plan sin figma → sin warning.

### B. `planner.md` — sección `## Design` para tickets visuales
- Cuando el ticket es visual (link Figma o screenshots), agregar `## Design` con: la
  **referencia** (link Figma + / o screenshots), los **frames/nodes** concretos, **breakpoints**,
  y **estados** (hover/focus/empty/loading/error). Anotar si hay un **Figma MCP disponible**
  para sacar tokens exactos. Si no es visual, omitir (no inventar diseño para backend).

### C. `implementer.md` — usar Figma MCP si está, si no screenshots
- Si el subtask trae refs de diseño: **con Figma MCP** configurado, sacar tokens/medidas/
  tipografía/espaciado exactos de los nodes referenciados; **sin él**, trabajar de los
  screenshots + specs del `## Design`. Nunca afirmar "pixel perfect": apuntar a design-accurate.

### D. `qa.md` — check visual contra la referencia
- Si el plan tiene `## Design`, sumar un **check visual**: con Figma MCP + browser (Playwright/
  Cursor) comparar lo renderizado vs la referencia Figma y reportar PASS/FAIL visual por
  estado/breakpoint; **sin Figma MCP**, comparar contra los screenshots. Evidencia = screenshot
  (ya existe). Honesto: "verificado contra la referencia de diseño", no pixel-perfect.

### E. `ticket.md` — capa de diseño en el flujo
- Preámbulo/paso: si el ticket es visual, el planner captura el diseño, el implementer usa el
  Figma MCP si está (si no screenshots), y la fase QA suma el check visual. Detect→use→degrade.

### F. Docs
- README (EN/ES) + README de claude-extras: párrafo "design-aware" (detecta Figma MCP, si no
  screenshots; honesto). Landing: mención en el card de QA o un beneficio corto. Bump versión.

## Verificación
1. `pnpm -r build && pnpm -r test` verde (nuevos tests del validator).
2. `validatePlan`: plan con `figma.com` sin `## Design` → `missing-design-capture`; con la
   sección → limpio; sin figma → sin warning.
3. Prompts coherentes con el patrón detect→use→degrade (revisión manual).

## Release
Minor → changeset `@chamba/core` (validator) + `@chamba/claude-extras` (prompts) → **0.14.0**.
