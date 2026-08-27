/** Normalize a git path for set comparisons: posix slashes, no leading `./`. */
export function normalizeGitPath(raw: string): string {
  let p = raw.trim().replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1);
  }
  return p;
}

/** Parse `git status --porcelain` into relative paths (including untracked). */
export function parseStatusPaths(porcelain: string): string[] {
  const out: string[] = [];
  for (const raw of porcelain.split('\n')) {
    if (raw.length < 4) continue;
    const rest = raw.slice(3);
    // Renames: `R  old -> new` — the new path is what overlap cares about.
    const arrow = rest.indexOf(' -> ');
    const path = arrow >= 0 ? rest.slice(arrow + 4) : rest;
    const n = normalizeGitPath(path);
    if (n.length > 0) out.push(n);
  }
  return unique(out);
}

/** Parse newline-separated `git diff --name-only` (or merge-tree --name-only). */
export function parseNameOnly(stdout: string): string[] {
  const out: string[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (/\s/.test(line)) continue;
    if (/^(merged|auto-merging|warning|hint|fatal|error):/i.test(line)) continue;
    out.push(normalizeGitPath(line));
  }
  return unique(out);
}

export function unique(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}

/** Parse `git rev-list --left-right --count A...B` → `{ behind, ahead }`. */
export function parseLeftRightCount(stdout: string): { behind: number; ahead: number } | undefined {
  const parts = stdout.trim().split(/\s+/);
  if (parts.length < 2) return undefined;
  const behind = Number(parts[0]);
  const ahead = Number(parts[1]);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return undefined;
  return { behind, ahead };
}
