# Plan — Design sources enlazables (`.chamba/design/` + `chamba_load_design`)

> Estado: ✅ Completada — 0.18.0 · Respeta los 10 principios (cero LLM).

## Idea
Hoy el design-aware (0.14) funciona **por ticket** (pegás un Figma/screenshots en `## Design`).
Esto lo hace **persistente y reusable**: registrás *dónde viven tus diseños* una vez, y el
planner/implementer/qa los resuelven solos en cada ticket. Funciona en Cursor y Claude Code
(la pieza central es una tool MCP; los extras la cablean).

**4 tipos de fuente** (cualquiera alcanza, se pueden combinar):
1. **Carpeta de imágenes** — mockups/screenshots (PNG/JPG/SVG…).
2. **Prompt/spec de texto** — el brief que te da Claude Design / tus notas de estados+breakpoints.
3. **Link de Figma** — con Figma MCP saca tokens; sin él, screenshots.
4. **Standalone/ZIP** — el prototipo que te da Claude Code (un `.html` o un `.zip`): el
   implementer/qa lo **abren/corren** para ver el objetivo real.

**Límites de filosofía:** chamba **enlaza, lista y lee texto — no interpreta el diseño**
(principio #1); el modelo del editor (+ Figma MCP / browser / imágenes) hace lo visual. El
diseño se **enlaza fuera del repo** (read-only), no se commitea — mismo criterio que la
evidencia de QA. Sin versionado ni diffing (scope creep).

## Formato de una fuente (`.chamba/design/<name>.md`)
```markdown
---
name: checkout-redesign
description: Nuevo flujo de checkout — 3 pantallas
figma: https://figma.com/...          # opcional
folder: ~/Designs/checkout            # opcional: carpeta externa (imágenes + specs + prototipo)
prototype: ~/Designs/checkout/app.html # opcional: .html o .zip para abrir/correr
---
<brief / el prompt que te dio Claude Design / estados, breakpoints, tokens>
```

## Cambios

### A. Core — módulo design (determinista, cero LLM)
- **NUEVO `packages/core/src/design/design.ts`** — `DesignRef {name, description, figma?, folder?,
  prototype?, path}`; `DesignAsset {kind: 'image'|'spec'|'prototype'|'other', path, name}`;
  `Design = DesignRef & { brief: string; assets: DesignAsset[] }`.
- **NUEVO `packages/core/src/design/design-registry.ts`** — `DESIGN_DIR='design'`;
  `parseDesignFrontmatter`, `collectDesignRefs(fs, dirs)` (dedup por name, ignora README/INDEX),
  `rankDesigns(task, refs, max)` (scoring por keywords, igual que skills), `readDesign(fs, ref)`:
  lee el **brief** (cuerpo) + lista **assets** de `folder` — imágenes (png/jpg/gif/webp/svg),
  specs (`.md`/`.txt` leídos inline y acotados), prototipos (`.html`/`.htm`/`.zip`) — más
  `prototype`/`figma` del frontmatter. Todo **acotado** (máx N assets, presupuesto de chars).
- Export desde `index.ts`. Tests: parse, collect ignora README, rank ordena/filtra, readDesign
  categoriza assets y tolera carpeta ausente.

### B. MCP — tool `chamba_load_design`
- **NUEVO `packages/mcp/src/tools/load-design.ts`** — input `{ task, max? }`. Escanea
  `<cwd>/.chamba/design` + `<home>/.chamba/design`, rankea, devuelve las top-N con: brief,
  `figma`, y el **listado de assets** (paths de imágenes/prototipos para que el editor los abra;
  specs `.md` inline). Vacío → mensaje de cómo crear una fuente (discoverable, opt-in).
- Registrar en `server.ts`; sumar al snapshot de `server.test.ts`.

### C. claude-extras — cablea el flujo design-aware (extiende 0.14)
- `planner.md`: para tickets visuales, llamar `chamba_load_design` y armar el `## Design` desde
  la fuente enlazada (figma / carpeta / prototipo / brief).
- `implementer.md`: construir contra tokens de **Figma MCP** si está, o contra las **imágenes/spec**;
  y **abrir el standalone** (`.html` en browser / descomprimir el `.zip`) como referencia de
  comportamiento. Design-accurate, no pixel-perfect.
- `qa.md`: check visual contra esa misma referencia (incluye abrir el prototipo).
- `ticket.md` / `orq.md`: el paso de diseño carga la fuente.
- **NUEVO comando `/design`** — `link <name> <carpeta|.html|.zip|figma-url>` crea el
  `.chamba/design/<name>.md`; `list` lista las fuentes. (Claude Code; la tool es el core agnóstico.)

### D. Preferencia de arquitectura de UI (preguntar una vez, guardar y reusar)
- **Archivo `.chamba/design/conventions.json`** — `{ web?, mobile? }` (strings). Separa web y
  móvil porque la arquitectura difiere (Atomic Design en web vs screens+components en Expo).
- **Set conocido (sugerencias, no validación rígida)** en core `KNOWN_ARCHITECTURES`:
  - web: `atomic` (Atomic Design), `feature-sliced` (FSD), `component-driven` (components/ + Storybook), `by-route`.
  - mobile: `screens` (screens/ + components/, expo-router), `atomic`, `feature-sliced`.
- **Tool `chamba_design_prefs { web?, mobile? }`** — sin args: devuelve las prefs actuales (get);
  con args: mergea y escribe `conventions.json`, devuelve las actualizadas (set). Lee proyecto →
  global (`~/.chamba/design`); escribe a proyecto.
- **`chamba_load_design` también devuelve `conventions`** — así el planner ve fuente + arquitectura
  en una sola llamada al inicio del ticket.
- **planner.md**: en un ticket visual, tras `chamba_load_design`, si la arquitectura relevante
  (**web** o **mobile** según la detección `## Mobile` de 0.16) **no está guardada → PREGUNTA**
  al humano ("¿Atomic Design, Feature-Sliced, component-driven…?"), **guarda** con
  `chamba_design_prefs`, y estructura el `## Design` + los subtasks a esa metodología (p.ej. atoms/
  molecules/organisms). En tickets siguientes reusa lo guardado sin volver a preguntar.
- **implementer.md**: sigue la arquitectura guardada (estructura de carpetas + granularidad de
  componentes). En Expo/móvil usa la pref mobile.

### E. Reviewer heurístico — DESCARTADO
- El validator es texto-puro sobre el plan (sin acceso a fs), así que no puede resolver si una
  carpeta/prototipo externo existe → un `design-source-unresolved` sería adivinanza ruidosa. Se
  deja al tool + planner (que sí resuelven). Sin heurística nueva para no meter falsos positivos.

### F. Docs
- README EN/ES: filas `chamba_load_design` + `chamba_design_prefs` + bullet en la sección
  design-aware. claude-extras README: sección "Design sources" (+ cómo conectar + la preferencia
  de arquitectura). Landing: filas en tools + mención + timeline. Bump versión.

## Cómo se conecta (uso)
1. **Enlazás** tu diseño una vez: `/design link checkout ~/Designs/checkout` (o un `.html`/`.zip`/
   Figma URL). Crea `.chamba/design/checkout.md` apuntando a esa carpeta externa.
2. En el primer ticket visual, el planner **te pregunta** la arquitectura (Atomic Design / …) y la
   **guarda**. Desde ahí no vuelve a preguntar (salvo que la cambies con `/design` o editando
   `conventions.json`).
3. En cada ticket, `chamba_load_design` trae la fuente que matchea + la arquitectura → planner
   arma el `## Design`, implementer abre el standalone y construye a esa metodología, qa valida.

## Verificación
1. `pnpm -r build && pnpm -r test` verde (design-registry + tool + validator).
2. `.chamba/design/checkout.md` con `folder` → `chamba_load_design {task}` devuelve brief + imágenes
   + prototipo; sin fuentes → mensaje de cómo crearlas.
3. Flujo: ticket visual → planner arma `## Design` desde la fuente → implementer abre el standalone
   y construye contra las imágenes/tokens → qa hace el check visual.

## Release
Minor (módulo + tool + comando + prompts) → lockstep **0.18.0**. El #4 (release-quality) pasa a 0.19.0.
