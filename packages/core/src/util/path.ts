/**
 * Minimal posix-style path helpers. `@chamba/core` avoids `node:path` so it can
 * run in non-Node runtimes; all internal paths use `/` as separator.
 */

export function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/');
}

export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

export function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? '' : trimmed.slice(0, idx);
}

/** Extension including the dot (e.g. `.ts`), or `''` if none. */
export function extname(path: string): string {
  const base = basename(path);
  const idx = base.lastIndexOf('.');
  return idx <= 0 ? '' : base.slice(idx);
}
