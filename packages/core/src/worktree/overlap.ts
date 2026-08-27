/** Two worktrees (or subtasks) whose changed-file sets intersect. */
export interface FileOverlap {
  a: string;
  b: string;
  files: string[];
}

export interface PartitionItem {
  id: string;
  paths: string[];
}

export interface PartitionWave {
  ids: string[];
}

export interface PartitionResult {
  /** Greedy packing: no two items in a wave share a path. */
  waves: PartitionWave[];
  overlaps: FileOverlap[];
  /** Size of the largest wave — safe fan-out if you run one wave at a time. */
  maxWaveSize: number;
}

function pathSet(paths: string[]): Set<string> {
  return new Set(paths.filter((p) => p.length > 0));
}

/** Pairwise path intersections. Pure. `id` is a worktree path, branch, or subtask. */
export function findOverlaps(items: PartitionItem[]): FileOverlap[] {
  const overlaps: FileOverlap[] = [];
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    if (!a) continue;
    const aSet = pathSet(a.paths);
    if (aSet.size === 0) continue;
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (!b) continue;
      const files = [...aSet].filter((p) => pathSet(b.paths).has(p)).sort();
      if (files.length > 0) overlaps.push({ a: a.id, b: b.id, files });
    }
  }
  return overlaps;
}

/**
 * Assign items to waves so no two items that share a path run together.
 * Deterministic: items keep their input order; each joins the earliest wave
 * that does not overlap it, or starts a new wave.
 */
export function partitionByOverlap(items: PartitionItem[]): PartitionResult {
  const overlaps = findOverlaps(items);
  const waves: Array<{ ids: string[]; paths: Set<string> }> = [];

  for (const item of items) {
    const set = pathSet(item.paths);
    let placed = false;
    for (const wave of waves) {
      let hits = false;
      for (const p of set) {
        if (wave.paths.has(p)) {
          hits = true;
          break;
        }
      }
      if (!hits) {
        wave.ids.push(item.id);
        for (const p of set) wave.paths.add(p);
        placed = true;
        break;
      }
    }
    if (!placed) {
      waves.push({ ids: [item.id], paths: new Set(set) });
    }
  }

  const resultWaves = waves.map((w) => ({ ids: w.ids }));
  const maxWaveSize = resultWaves.reduce((m, w) => Math.max(m, w.ids.length), 0);
  return { waves: resultWaves, overlaps, maxWaveSize: Math.max(1, maxWaveSize) };
}
