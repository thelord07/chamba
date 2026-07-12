# Plan — Tier 3 · #2: Registry de skills/playbooks (index-first)

> Estado: ✅ Completada — 0.15.0 · Respeta los 10 principios (cero LLM).

## Idea
Playbooks/convenciones reutilizables en `.chamba/skills/*.md` con frontmatter
`{name, description, scope?}`. chamba **matchea la tarea contra las descriptions** (scoring
por keywords, como la memoria/context) y devuelve las skills relevantes; el **modelo del
editor lee el cuerpo completo** solo de las que aplican. Cero LLM del lado de chamba. Se
envía **vacío** (opt-in): la comunidad/el equipo lo llena. Ojo scope creep → mínimo.

## Formato de una skill (`.chamba/skills/<name>.md`)
```
---
name: knex-multitenant
description: Patrón de queries multi-tenant con Knex (siempre filtrar por tenant_id)
scope: backend        # opcional
---
<cuerpo: pasos, convenciones, gotchas, ejemplos>
```

## Cambios

### A. Core — módulo de skills
- **NUEVO `packages/core/src/skills/skill.ts`** — tipos `SkillRef {name, description, scope?, path}`
  y `Skill = SkillRef & { body }`.
- **NUEVO `packages/core/src/skills/skill-registry.ts`**:
  - `parseSkillFrontmatter(content, path) → SkillRef | null` — extrae `name`/`description`/`scope`
    del frontmatter YAML simple; requiere al menos `name`.
  - `collectSkillRefs(fs, dirs) → SkillRef[]` — escanea cada dir por `*.md` (ignora `README.md`),
    parsea frontmatter (archivos chicos → barato).
  - `rankSkills(task, refs, max) → SkillRef[]` — scoring por keywords (tarea ↔ name+description+scope),
    top-N (default 3), score > 0.
  - `readSkillBody(fs, path) → string` (cuerpo tras el frontmatter).
  - Scoring self-contained (keywords: lowercase, split no-alfanum, len≥3, sin stopwords; suma de
    ocurrencias) — mismo criterio que `context-builder`.
- Tests `skill-registry.test.ts` (parse, collect ignora README/no-frontmatter, rank ordena/filtra).
- Export desde el índice de core.

### B. MCP — tool `chamba_load_skills`
- **NUEVO `packages/mcp/src/tools/load-skills.ts`** — input `{ task, max? }`. Escanea
  `<cwd>/.chamba/skills` + `<home>/.chamba/skills`, rankea, devuelve las top-N **con cuerpo**
  + la lista de todas las skills disponibles (name+description) para que el modelo sepa qué más
  hay. Si no hay ninguna → mensaje que explica cómo crearlas (discoverable, opt-in).
- Registrar en `server.ts`; sumar `chamba_load_skills` al snapshot de `server.test.ts`.

### C. claude-extras — wiring en la orquestación
- `ticket.md` (paso 1) y `orq.md` (paso 1): tras `load_context`, llamar `chamba_load_skills`
  con la tarea para traer playbooks/convenciones que apliquen (si hay). Que el modelo lea el
  cuerpo de las que matcheen y las respete.

### D. Docs
- README (EN/ES): fila `chamba_load_skills` + bullet corto (playbooks index-first, opt-in, vacío
  por defecto). README de claude-extras: sección "Skills / playbooks". Landing: fila en tools +
  mención. Bump versión.

## Verificación
1. `pnpm -r build && pnpm -r test` verde (nuevos tests).
2. `collectSkillRefs` ignora README/sin-frontmatter; `rankSkills` ordena por relevancia y filtra 0.
3. Tool: con skills en `.chamba/skills`, `chamba_load_skills {task}` devuelve la relevante con cuerpo;
   sin skills → mensaje de cómo crearlas.

## Release
Minor → changeset `@chamba/core` + `@chamba/mcp` + `@chamba/claude-extras` → **0.15.0**.
