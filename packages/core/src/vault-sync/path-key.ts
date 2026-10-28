/**
 * vault-sync/path-key.ts — case-insensitive path identity helpers.
 * Leaf module: imports nothing from vault-sync. No Node APIs, no LLM.
 */

/**
 * Canonical key for a vault path: NFC-normalized + lowercased.
 * Used to detect case-insensitive path collisions (macOS/Windows FS).
 * Idempotent: pathKey(pathKey(x)) === pathKey(x).
 */
export function pathKey(p: string): string {
  return p.normalize('NFC').toLowerCase();
}

/**
 * Find groups of paths that collide under case-insensitive comparison.
 * Returns only groups with ≥2 distinct paths.
 * Within each group, paths appear in first-seen order (identical strings deduplicated).
 * Groups appear in first-seen order of their canonical key.
 */
export function findCaseCollisions(paths: string[]): string[][] {
  const groups = new Map<string, string[]>();
  const order: string[] = [];

  for (const p of paths) {
    const k = pathKey(p);
    let group = groups.get(k);
    if (group === undefined) {
      group = [];
      groups.set(k, group);
      order.push(k);
    }
    // Deduplicate identical strings within the group
    if (!group.includes(p)) {
      group.push(p);
    }
  }

  const result: string[][] = [];
  for (const k of order) {
    const group = groups.get(k);
    if (group !== undefined && group.length >= 2) {
      result.push(group);
    }
  }
  return result;
}
