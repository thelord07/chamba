/**
 * tasks/evidence-paths.ts — CHAMBA-022 (B8)
 *
 * `VAULT_SKIP_DIRS` only compares the top-level path segment
 * (`relPath.split('/')[0]`), so it can never match `tareas/<id>/evidencia/`
 * — a nested path. Every walker that must not treat an evidence file as a
 * knowledge note uses this prefix rule instead.
 *
 * Deliberately NOT used by `isSyncable` (vault-sync/sync-filter.ts): evidence
 * DOES get synced to the parche vault — this only keeps it out of the
 * knowledge graph (reindex, classify, topics, backlinks).
 *
 * `isEvidenceImagePath` (O1 — owner decision 2026-11-13) is the ONE place
 * that DOES interact with sync: images under a task's evidence subtree are
 * opt-in (`vault.syncEvidence: true`), while `report.md`/`tests-*.md` always
 * sync like any other `.md`. `isSyncable` itself is untouched (B8 note
 * above) — `vault-sync/runner.ts` applies this as an ADDITIONAL filter on
 * top of it, never instead of it.
 */

// N6: case-insensitive — a case-insensitive filesystem (macOS default, Windows)
// can hand back `Tareas/.../Evidencia` for a path chamba itself wrote lowercase;
// the prefix check must not depend on the walker preserving chamba's casing.
const TASK_EVIDENCE_PREFIX = /^tareas\/[^/]+\/evidencia(\/|$)/i;

const EVIDENCE_IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp|svg)$/i;

/** True when `relPath` (vault-relative, `/`-separated) is under a task's evidence subtree. */
export function isTaskEvidencePath(relPath: string): boolean {
  return TASK_EVIDENCE_PREFIX.test(relPath);
}

/**
 * True when `relPath` is an IMAGE under a task's evidence subtree — the
 * subset O1 gates behind `vault.syncEvidence`. `report.md`/`tests-*.md`
 * (text) are never matched here, so they keep syncing unconditionally.
 */
export function isEvidenceImagePath(relPath: string): boolean {
  return isTaskEvidencePath(relPath) && EVIDENCE_IMAGE_EXTENSIONS.test(relPath);
}
