/**
 * local-path.ts — helpers for LOCAL (OS-native) paths.
 *
 * Unlike `util/path.ts` (POSIX-only wire paths), these helpers understand
 * Windows drive letters, UNC paths and mixed separators.
 *
 * Design constraints (D1):
 *  - Minimal scope: only what the parche client needs (isAbsolute, normalize,
 *    join, resolve against cwd, dirname, basename, relative, caseFold, detectStyle).
 *  - Lexical only — no FS calls. `realpath` stays in the adapter layer.
 *  - No `node:` imports — core must stay runtime-agnostic.
 *  - `style: 'posix' | 'win32'` is injectable for cross-platform testing.
 *  - Drive-relative paths (`C:foo`, without a separator) and device paths
 *    (`\\?\…`, `\\.\…`) are REJECTED with a clear error (not silently accepted).
 *  - Vault-relative wire paths (protocol layer, always POSIX `/`) NEVER go
 *    through this module.
 */

export type PathStyle = 'posix' | 'win32';

// ─── detectStyle ─────────────────────────────────────────────────────────────

/**
 * Map `process.platform` to a `PathStyle`. Anything that is not `'win32'`
 * is treated as POSIX.
 */
export function detectStyle(platform: string): PathStyle {
  return platform === 'win32' ? 'win32' : 'posix';
}

// ─── Validation helpers ───────────────────────────────────────────────────────

/**
 * Throw with a clear message when `path` is a device path (`\\?\…` / `\\.\…`)
 * or a drive-relative path like `C:foo` (no separator after colon).
 *
 * Only meaningful on Windows (`style === 'win32'`). On POSIX, `a:b` is a valid
 * relative directory name and this function returns immediately.
 *
 * @param style - Path style; defaults to `'win32'` for backward-compatibility
 *   with callers that do not pass a style. Internal helpers always pass their
 *   resolved style.
 */
export function assertNotUnsupportedPath(path: string, style: PathStyle = 'win32'): void {
  if (style !== 'win32') return;
  // Device paths: \\?\ and \\.\
  if (/^[/\\]{2}[?.]([/\\]|$)/.test(path)) {
    throw new Error(
      `La ruta "${path}" usa el prefijo de dispositivo (\\\\?\\ o \\\\.\\), que no está soportado. ` +
        `Usa una ruta absoluta normal como C:\\carpeta\\vault.`,
    );
  }
  // Drive-relative: C:foo (letter + colon, then non-separator) or bare C: (no separator at all)
  if (/^[A-Za-z]:[^/\\]/.test(path) || /^[A-Za-z]:$/.test(path)) {
    throw new Error(
      `La ruta "${path}" es relativa a la unidad (drive-relative). ` +
        `Usa una ruta absoluta como C:\\carpeta\\vault o una ruta relativa como .\\vault.`,
    );
  }
}

// ─── isAbsoluteLocal ─────────────────────────────────────────────────────────

/**
 * Return true when `path` is absolute on the given platform.
 *
 * - posix: starts with `/`
 * - win32: drive root (`C:\` / `C:/`), UNC (`\\server\share`), or POSIX-style
 *   absolute (`/`)
 *
 * Bare `C:` (without separator) is NOT absolute — it is drive-relative and
 * triggers `assertNotUnsupportedPath` when passed here.
 */
export function isAbsoluteLocal(path: string, style: PathStyle): boolean {
  assertNotUnsupportedPath(path, style);
  if (style === 'win32') {
    // Drive root: letter + colon + separator
    if (/^[A-Za-z]:[/\\]/.test(path)) return true;
    // UNC root: two separators + host + separator + share (minimum)
    if (/^[/\\]{2}[^/\\?.]/.test(path)) return true;
    // POSIX-style absolute on Windows (e.g. /foo) — treated as absolute
    if (path.startsWith('/')) return true;
    return false;
  }
  return path.startsWith('/');
}

// ─── toAbsoluteLocal ─────────────────────────────────────────────────────────

/**
 * If `p` is already absolute, return it unchanged. Otherwise resolve it against
 * `cwd`. The result is NOT normalized — call `normalizeLocal` if needed.
 */
export function toAbsoluteLocal(cwd: string, p: string, style: PathStyle): string {
  if (isAbsoluteLocal(p, style)) return p;
  return joinLocal(cwd, p);
}

// ─── joinLocal ────────────────────────────────────────────────────────────────

/**
 * Join path segments with the platform separator. Collapses duplicate separators.
 * Does NOT normalize `.` / `..` — call `normalizeLocal` for that.
 */
export function joinLocal(base: string, ...parts: string[]): string {
  let result = base;
  for (const p of parts) {
    if (p.length === 0) continue;
    const sep = result.endsWith('/') || result.endsWith('\\') ? '' : '/';
    result = result + sep + p;
  }
  // Collapse duplicate separators, but preserve the leading \\ or // of UNC paths
  // (e.g. \\srv\share or //srv/share). A plain regex collapse would turn \\ → /.
  const uncMatch = /^([/\\]{2})/.exec(result);
  if (uncMatch) {
    return (uncMatch[1] ?? '') + result.slice(2).replace(/[/\\]{2,}/g, '/');
  }
  return result.replace(/[/\\]{2,}/g, '/');
}

// ─── _splitRoot ───────────────────────────────────────────────────────────────

/**
 * Split a path into its root prefix (e.g. `C:\`, `\\server\share\`, `/`)
 * and the rest. Internal helper.
 */
function splitRoot(path: string, style: PathStyle): { root: string; rest: string } {
  if (style === 'win32') {
    // UNC: \\host\share or //host/share
    const unc = /^([/\\]{2}[^/\\]+[/\\][^/\\]+)([/\\]?)(.*)$/.exec(path);
    if (unc) {
      const root = (unc[1] ?? '') + (unc[2] || '\\');
      return { root, rest: unc[3] ?? '' };
    }
    // Drive: C:\ or C:/
    const drive = /^([A-Za-z]:[/\\])(.*)$/.exec(path);
    if (drive) {
      return { root: drive[1] ?? '', rest: drive[2] ?? '' };
    }
    // POSIX-style absolute on Windows
    if (path.startsWith('/')) {
      const rest = path.slice(1);
      return { root: '/', rest };
    }
  } else {
    if (path.startsWith('/')) {
      return { root: '/', rest: path.slice(1) };
    }
  }
  return { root: '', rest: path };
}

// ─── normalizeLocal ───────────────────────────────────────────────────────────

/**
 * Lexically normalize a local path:
 *  - Resolve `.` and `..` without crossing the root.
 *  - Collapse multiple separators.
 *  - Remove trailing separator (except pure root).
 *  - On win32, output uses `\` as separator.
 *  - On posix, output uses `/`.
 */
export function normalizeLocal(path: string, style: PathStyle): string {
  assertNotUnsupportedPath(path, style);
  const { root, rest } = splitRoot(path, style);
  const sep = style === 'win32' ? '\\' : '/';

  const parts = rest.split(/[/\\]+/).filter((p) => p.length > 0);
  const out: string[] = [];
  for (const p of parts) {
    if (p === '.') continue;
    if (p === '..') {
      if (out.length > 0) out.pop();
      // else: trying to go above root — silently clamp
    } else {
      out.push(p);
    }
  }

  if (root.length > 0) {
    // For a plain `/` root on win32 (POSIX-style absolute — common in tests with
    // MemoryFilesystem), keep `/` as separator to stay compatible with that FS.
    const isPlainPosixRoot = root === '/';
    const effectiveSep = isPlainPosixRoot ? '/' : sep;
    const normRoot = style === 'win32' && !isPlainPosixRoot ? root.replace(/\//g, '\\') : root;
    if (out.length === 0) {
      // Pure root — return without trailing sep (or the root itself if it would be empty)
      const stripped = normRoot.replace(/[/\\]+$/, '');
      return stripped || normRoot;
    }
    // Normalize root: ensure it ends without a trailing sep
    const rootBase = normRoot.replace(/[/\\]+$/, '');
    return rootBase + effectiveSep + out.join(effectiveSep);
  }

  // Relative path
  return out.join(sep);
}

// ─── localDirname ─────────────────────────────────────────────────────────────

/**
 * Return the parent directory of `path`, stopping at the filesystem root
 * (drive root or `/`) instead of returning an empty string.
 *
 * Equivalent to `node:path.dirname` but injectable by style and free of
 * `node:` imports.
 */
export function localDirname(path: string, style: PathStyle): string {
  assertNotUnsupportedPath(path, style);
  const sep = style === 'win32' ? '\\' : '/';
  const { root, rest } = splitRoot(path, style);

  // Normalize separators in rest
  const normRest = rest.replace(/[/\\]+$/, ''); // strip trailing
  const lastSep = Math.max(normRest.lastIndexOf('/'), normRest.lastIndexOf('\\'));

  // For plain `/` root on win32 (POSIX-style paths — common in tests), keep `/`
  const isPlainPosixRoot = root === '/';
  const effectiveSep = isPlainPosixRoot ? '/' : sep;

  if (lastSep < 0) {
    // No separator in rest — parent is the root (or same if root is '')
    if (root.length > 0) {
      const normRoot = style === 'win32' && !isPlainPosixRoot ? root.replace(/\//g, '\\') : root;
      // Keep the root's trailing separator, like node:path: `C:\x` → `C:\` (not the
      // drive-relative `C:`), `\\srv\share\x` → `\\srv\share\`.
      return normRoot;
    }
    // Pure relative segment with no parent
    return '.';
  }

  const parentRest = normRest.slice(0, lastSep);
  if (root.length > 0) {
    const normRoot = style === 'win32' && !isPlainPosixRoot ? root.replace(/\//g, '\\') : root;
    const rootBase = normRoot.replace(/[/\\]+$/, '');
    if (parentRest.length === 0) return rootBase + effectiveSep;
    return rootBase + effectiveSep + parentRest.replace(/[/\\]/g, effectiveSep);
  }
  return parentRest.length > 0 ? parentRest.replace(/[/\\]/g, effectiveSep) : '.';
}

// ─── localBasename ────────────────────────────────────────────────────────────

/**
 * Return the last component of `path` (file/dir name), stripping trailing
 * separators. Similar to `node:path.basename` (without extension stripping).
 */
export function localBasename(path: string, style: PathStyle): string {
  assertNotUnsupportedPath(path, style);
  const { rest } = splitRoot(path, style);
  const normRest = rest.replace(/[/\\]+$/, '');
  const lastSep = Math.max(normRest.lastIndexOf('/'), normRest.lastIndexOf('\\'));
  if (lastSep < 0) return normRest;
  return normRest.slice(lastSep + 1);
}

// ─── caseFoldLocal ────────────────────────────────────────────────────────────

/**
 * Canonical form for comparison on case-insensitive filesystems (win32 / macOS HFS+).
 * - Lowercases the entire path.
 * - Normalizes separators to `/`.
 *
 * On POSIX (case-sensitive), returns the path unchanged.
 */
export function caseFoldLocal(path: string, style: PathStyle): string {
  if (style !== 'win32') return path;
  // Lowercase + unify separators for case-insensitive comparison
  return path.toLowerCase().replace(/\\/g, '/');
}

// ─── localRelative ────────────────────────────────────────────────────────────

/**
 * Return a relative path from `base` to `target`.
 * - On win32, the comparison is case-insensitive.
 * - If `target` is not under `base`, returns `target` unchanged (absolute).
 * - Both paths should be absolute (or both relative to the same root).
 */
export function localRelative(base: string, target: string, style: PathStyle): string {
  // Normalize separators for comparison
  const normBase = style === 'win32' ? caseFoldLocal(base, style) : base;
  const normTarget = style === 'win32' ? caseFoldLocal(target, style) : target;

  // Ensure base ends with separator for clean prefix check
  const baseWithSep = normBase.endsWith('/') ? normBase : `${normBase}/`;

  if (normTarget.startsWith(baseWithSep)) {
    return target.slice(baseWithSep.length);
  }
  if (normTarget === normBase) return '.';
  return target;
}

// ─── isUnderLocal ─────────────────────────────────────────────────────────────

/**
 * Containment check for already-resolved LOCAL paths (typically the result
 * of `fs.realpath`), portable to win32 (CHAMBA-022, B5/B7).
 *
 * Both paths are case-folded per `style` (no-op on posix, lowercased +
 * separator-unified on win32) before comparison — the single helper every
 * realpath-containment check in the codebase should go through, instead of
 * each callsite hand-rolling a POSIX-only `startsWith('/')`.
 *
 * `strict: true` (B7) rejects `candidate === root` — used when `root` must
 * be a strict ANCESTOR of `candidate` (e.g. a worktree can never BE the
 * workspace root). Default `false` allows equality (e.g. `cmd.cwd` defaults
 * to the worktree root itself).
 */
export function isUnderLocal(
  root: string,
  candidate: string,
  style: PathStyle,
  opts: { strict?: boolean } = {},
): boolean {
  const foldRoot = caseFoldLocal(root, style).replace(/[/\\]+$/, '');
  const foldCandidate = caseFoldLocal(candidate, style).replace(/[/\\]+$/, '');
  if (foldCandidate === foldRoot) return opts.strict !== true;
  // caseFoldLocal already unifies win32 separators to '/'; posix paths use '/' natively.
  return foldCandidate.startsWith(`${foldRoot}/`);
}

// ─── sameLocalPath ────────────────────────────────────────────────────────────

/**
 * NB-1 (CHAMBA-022 round 2 review): compare two local paths for EQUALITY
 * tolerant of a trailing separator ("/a/b/" vs "/a/b") and, on win32, case
 * — never a bare `===`, which false-positives on either. Pairs with
 * `isUnderLocal`'s own fold+strip logic; use this when the two paths are
 * meant to name the SAME directory/file, not one containing the other.
 */
export function sameLocalPath(a: string, b: string, style: PathStyle): boolean {
  const norm = (p: string) => caseFoldLocal(p, style).replace(/[/\\]+$/, '');
  return norm(a) === norm(b);
}

// ─── isInvalidPath ────────────────────────────────────────────────────────────

/**
 * Return `true` when `relPath` (a vault-relative wire path, components separated
 * by `/`) contains a component that is invalid as a Windows file or directory name.
 *
 * Checks every `/`-separated component for:
 *  - Characters forbidden on Windows: `< > : " \ | ? *` and control chars 0x00–0x1F
 *  - Reserved device names (case-insensitive, with or without extension):
 *    CON, PRN, AUX, NUL, COM1–COM9, LPT1–LPT9
 *  - Trailing space or dot in a component
 *
 * Always returns `false` when `style !== 'win32'`.
 *
 * The path separator `/` itself is not checked (it is the split delimiter, not a
 * component character).
 */
export function isInvalidPath(relPath: string, style: PathStyle): boolean {
  if (style !== 'win32') return false;
  const components = relPath.split('/');
  for (const comp of components) {
    if (comp.length === 0) continue; // skip leading/trailing empty segments
    // Forbidden characters: < > : " \ | ? * and control chars 0x00–0x1F
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching Windows-forbidden control chars
    if (/[<>:"\\|?*\u0000-\u001f]/.test(comp)) return true;
    // Trailing space or dot
    if (/[ .]$/.test(comp)) return true;
    // Reserved device names (stem before first dot, case-insensitive)
    const stem = (comp.split('.')[0] ?? '').toUpperCase();
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) return true;
  }
  return false;
}
