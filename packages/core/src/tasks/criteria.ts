/**
 * tasks/criteria.ts — CHAMBA-022
 *
 * Acceptance-criteria ids. The TEXT of an AC is never edited by anyone but
 * `scope_change` (which appends, never rewrites — see scope-change.ts);
 * `chamba_digest` (task-store.ts, N1) is the actual integrity check against
 * a hand-edit of the criteria block — it's a strict superset of a
 * text-comparison guard (catches ANY edit, not just a text mismatch), so
 * this module only assigns ids.
 *
 * Pure TypeScript: no `node:` imports, no IO.
 */

export type AcId = string;

/** `AC-1`, `AC-2`, … in the order the texts were given. */
export function assignAcIds(texts: string[]): Array<{ id: AcId; text: string }> {
  return texts.map((text, i) => ({ id: `AC-${i + 1}`, text }));
}
