import { parseNameOnly, unique } from './status-files.js';

/**
 * Parse `git merge-tree --name-only` (Git 2.38+) or classic `git merge-tree`
 * output into conflicted paths. Pure — never merges.
 */
export function parseMergeTreeOutput(stdout: string, mode: 'name-only' | 'classic'): string[] {
  if (mode === 'name-only') return parseNameOnly(stdout);
  return parseClassicMergeTree(stdout);
}

function parseClassicMergeTree(stdout: string): string[] {
  const files: string[] = [];
  const lines = stdout.split('\n');
  let inConflictBlock = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(changed in both|added in both|removed in both)$/i.test(line)) {
      inConflictBlock = true;
      continue;
    }
    const conflictIn = /^(?:CONFLICT.*(?:in|for)\s+)(.+)$/i.exec(line);
    if (conflictIn?.[1]) {
      files.push(conflictIn[1].replace(/[.]$/, '').trim());
      inConflictBlock = false;
      continue;
    }
    if (inConflictBlock) {
      // `base 100644 <hash> path` / `our 100644 <hash> path`
      const m = /^(?:base|our|their)\s+\d{6}\s+\S+\s+(.+)$/.exec(line);
      if (m?.[1]) files.push(m[1].trim());
      else if (line.length === 0) inConflictBlock = false;
    }
  }
  return unique(files);
}
