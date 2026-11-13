/**
 * tasks/criteria.ts — CHAMBA-022
 *
 * Acceptance-criteria ids and the immutability guard: once a document is
 * written, the TEXT of an AC can never be edited by anyone but
 * `scope_change` (which appends, never rewrites — see scope-change.ts).
 *
 * Pure TypeScript: no `node:` imports, no IO.
 */

export type AcId = string;

/** `AC-1`, `AC-2`, … in the order the texts were given. */
export function assignAcIds(texts: string[]): Array<{ id: AcId; text: string }> {
  return texts.map((text, i) => ({ id: `AC-${i + 1}`, text }));
}

/**
 * Normalize text for comparison purposes only (never persisted): NFC, CRLF →
 * LF, trim, collapse internal whitespace runs. Tolerates re-saves across
 * platforms/editors but never tolerates an actual edit.
 */
export function normalizeAcText(text: string): string {
  return text.normalize('NFC').replace(/\r\n/g, '\n').trim().replace(/\s+/g, ' ');
}

export interface AcLike {
  id: AcId;
  text: string;
}

export type CriteriaImmutableResult = { ok: true } | { ok: false; changed: AcId[] };

/**
 * Compare the AC texts that existed in `prev` against the texts now present
 * in `next` (same `id`). Any AC whose normalized text differs is reported in
 * `changed`. ACs only present in `next` (newly added via `scope_change add`)
 * are not compared — this guard is about PREVENTING silent edits, not about
 * forbidding new criteria.
 */
export function assertCriteriaImmutable(prev: AcLike[], next: AcLike[]): CriteriaImmutableResult {
  const prevById = new Map(prev.map((ac) => [ac.id, ac.text]));
  const changed: AcId[] = [];
  for (const ac of next) {
    const prevText = prevById.get(ac.id);
    if (prevText === undefined) continue;
    if (normalizeAcText(prevText) !== normalizeAcText(ac.text)) {
      changed.push(ac.id);
    }
  }
  return changed.length === 0 ? { ok: true } : { ok: false, changed };
}
