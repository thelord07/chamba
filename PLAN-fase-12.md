# PLAN — Fase 12: Safe parallelism 2.0

> Ejecutable. Detalle de implementación de la idea 1 (`@LOCAL/NEW-FEATURES.md`).
> 5 sub-fases (12.1–12.5), tests verdes por sub-fase. **No auto-merge, no `--force`,
> no `git branch -D`.** chamba no llama LLMs.

---

## Resumen de la fase

Hoy `chamba_resource_budget` dimensiona workers por RAM/CPU y `chamba_list_worktrees`
devuelve path + branch. Eso no evita que dos worktrees editen el mismo archivo, que
`git merge` contra `main` choque, o que dos `/qa` peleen por `:3000`.

Esta fase añade inteligencia **programática** (git + config, cero LLM):

- status sucio / ahead-behind / unpushed / stale
- overlap de archivos **observado** (`git diff` + `status`)
- conflict preview con `git merge-tree` (**nunca mergea**)
- partition en waves (observed bloquea; predicted desde el plan = warning)
- ports opt-in: `.env.local` con `PORT` por worktree, sin matar procesos

Release objetivo: **minor 1.5.0**.

---

## Decisiones confirmadas

1. **Observed-first.** Overlap de verdad sale del diff/status. Paths predichos del plan
   (`files likely touched`) son warning, nunca `failOnOverlap`.
2. **Stale** solo si `ahead > 0`, último commit > 24 h y working tree limpio. Un worktree
   recién forkeado de `main` viejo **no** es stale. El checkout primario nunca es stale.
3. **Ports off por default.** Probe TCP localhost; si está ocupado, suma `step`. No Docker.
4. **`failOnOverlap` default false** — avisa y recomienda sequential.
5. **Git status es la fuente de verdad.** Cero locks/heartbeats/PIDs.
6. **No copiar `node_modules`.**

---

## Sub-fase 12.1 — Config + overlap/partition puros (`@chamba/core`)

**Goal:** tipos/schema `worktrees.ports` + `worktrees.overlap`; funciones puras de
overlap, partition, parse de status/merge-tree, upsert de env, porcelain extraído.

**Entregables:** `config/worktrees.ts` + schema; `worktree/porcelain.ts`;
`worktree/status-files.ts`; `worktree/overlap.ts`; `worktree/merge-tree.ts`;
`worktree/plan-paths.ts`; `worktree/env-upsert.ts`; `ports/net.ts`;
`mergeWorktreePartial` en el loader (nested ports/overlap).

**Tests:** defaults/merge/schema; overlap + greedy waves; merge-tree name-only + classic;
extract paths del plan; upsert env; porcelain.

---

## Sub-fase 12.2 — Inspector + conflict preview + ports (`@chamba/core`)

**Goal:** IO detrás de `ProcessPort` / `NetPort` / `ClockPort` / `FilesystemPort`.

**Entregables:** `WorktreeInspector` (por worktree: dirty, ahead/behind vs base, unpushed,
changed files, stale); overlap cruzado; `ConflictPreviewer` (`merge-tree --name-only`,
fallback classic); `allocatePort` + write `.env.local`; `applyOverlapCap` en el budget;
`FakeProcess` pasa `cwd` al handler.

**Tests:** FakeProcess por cwd; merge-tree fallback; allocate skip-in-use; overlap cap.

---

## Sub-fase 12.3 — Tools MCP

**Tools nuevas (24 → 28):**

| Tool | Input | Output |
|---|---|---|
| `chamba_worktree_status` | `{ repos?, baseBranch? }` | status + overlaps; `ok: false` si `failOnOverlap` |
| `chamba_conflict_preview` | `{ baseBranch?, branches? }` | conflictos vs base + pairwise; **nunca mergea** |
| `chamba_partition` | `{ plan?, items?, fromWorktrees? }` | waves + overlaps predicted/observed |
| `chamba_worktree_env` | `{ ticket?, worktreePath?, index? }` | escribe `.env.local`; no-op si ports off |

Upgrade `chamba_list_worktrees` (tabla dirty/overlap) y `chamba_create_worktrees`
(ports si enabled; `recommendedParallelism` también por overlap cuando hay diffs).

`NetPort` en `Services` (opt-in en tests).

---

## Sub-fase 12.4 — Extras + wizard

`/ticket` y `/orq`: status + partition antes del fan-out; conflict_preview antes del
STOP; sequential si overlap. `/worktrees`: status por default. Wizard: ports +
`failOnOverlap`. `config worktrees show` lista los campos nuevos.

---

## Sub-fase 12.5 — Docs + changeset

README EN/ES (tools + comparison row + bullet safe parallelism). `@chamba/mcp` README.
Changeset minor. PLAN.md ✅.

---

## DoD

- [ ] core puro + inspector/preview/ports, cero `node:*` en core, tests verdes
- [ ] 28 tools MCP, tests InMemoryTransport
- [ ] extras actualizados; wizard/config show
- [ ] nunca merge / `--force` / `branch -D` (tests)
- [ ] biome + `pnpm -r test` verdes; changeset 1.5.0
