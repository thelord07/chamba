---
"@chamba/core": minor
"@chamba/mcp": minor
"@chamba/claude-extras": minor
"@chamba/cursor-extras": minor
"@chamba/opencode-extras": minor
---

Rutas proporcionales (ODD paso 1 — CHAMBA-020): `chamba_classify_task` elige la ruta adecuada heurísticamente sin LLM (trivial → small → substantial → risky) con señales de riesgo categorizadas (`RISK_TERMS`) y tokens de DB wipe (`DB_WIPE_TOKENS`); `/ticket` y `/orq` siguen la ruta clasificada con tabla de 4 rutas, anuncio en una línea, `--route` para override, D3 de escalado y confirmación en risky; `chamba_task_metrics` registra hitos por ticket en `<wsRoot>/.chamba/metrics/tasks.jsonl` (gitignored, escritura atómica, sweep 7 días, sin texto del ticket ni secretos); CLI `npx @chamba/mcp metrics [--since Nd|Nh|Nw]` muestra tabla por ruta separada por source; rondas máximas pasan de 6 a 2 en todos los flujos.
