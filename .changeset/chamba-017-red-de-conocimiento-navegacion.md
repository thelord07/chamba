---
"@chamba/core": minor
"@chamba/mcp": minor
"@chamba/claude-extras": minor
"@chamba/cursor-extras": minor
"@chamba/opencode-extras": minor
---

CHAMBA-017: navegación de la red de conocimiento en el vault. Nueva tool `chamba_vault_navigate` que recorre el árbol de temas paso a paso — vista raíz (temas de primer nivel, carpetas, conteo sin clasificar), vista de nodo (subtemas, notas directas con `summary`/`keywords`, co-temas) y vista de nota (metadatos, backlinks calculados desde `related` y enlaces `[[…]]`/`(…)`, hermanas del mismo `work_item`, cuerpo opcional recortado a `maxChars`). Resuelve aliases (`crear-cursos` → `lms/cursos/creacion`), rechaza rutas absolutas, `..`, segmentos ocultos y extensiones no-`.md`. Corre `VaultReindexer` (write-only-changed, 2 s budget) antes de responder para auto-reparar derivados desactualizados; no dispara push ni autosync. `chamba_load_context` ahora devuelve `## Mapa del vault` (nodos relevantes + notas puntuadas por `summary`/`keywords`, notas de `work_item` mencionado siempre incluidas, presupuesto ≤ 25 % de `maxTokens`) cuando existe `INDEX.md` raíz chamba-generado; sin él, la salida actual `## Relevant notes` queda byte-idéntica (fallback). Ambas tools exponen `structuredContent` + `outputSchema` (Zod). Prompts actualizados (`agents/planner.md`, `agents/diagnostician.md`, `commands/ticket.md`, `commands/recall.md`, `commands/vault.md`) con la regla "Navega antes de leer": `load_context` → mapa, `chamba_vault_navigate` sobre nodos relevantes bajando a subtemas solo si su descripción aplica, `readBody` solo en notas con `summary`/`keywords` pertinentes, sección `Contexto consultado` en planes y tickets.
