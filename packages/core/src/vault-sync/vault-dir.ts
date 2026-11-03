/**
 * vault-sync/vault-dir.ts — vault directory resolution, validation and preparation.
 *
 * Single source of truth for the vault directory path. Pure: no Node imports.
 * All IO via FilesystemPort.
 *
 * Key functions:
 *   resolveVaultDir — compute the vault path from a credential (or the default).
 *   prepareVaultDir — validate a candidate path, create the directory, and return
 *                     the canonical path to store in the credential.
 */

import type { FilesystemPort } from '../ports/filesystem.js';
import { caseFoldLocal, detectStyle, normalizeLocal, toAbsoluteLocal } from '../util/local-path.js';
import { joinPath } from '../util/path.js';
import { ensureVaultGitignored, findGitRoot } from '../workspace/vault-safety.js';
import type { CredentialEntry } from './credentials.js';

// ─── resolveVaultDir ──────────────────────────────────────────────────────────

/**
 * Compute the vault directory for a credential.
 * Returns `cred.dir` if set, otherwise the default `<homedir>/.chamba/vaults/<slug>`.
 * This is the ONLY place where the default path is constructed in production.
 */
export function resolveVaultDir(
  cred: Pick<CredentialEntry, 'dir'>,
  homedir: string,
  slug: string,
): string {
  return cred.dir ?? joinPath(homedir, '.chamba', 'vaults', slug);
}

// ─── expandTilde ─────────────────────────────────────────────────────────────

/**
 * Expand a leading `~` or `~/` to the user home directory. Pure string operation.
 */
export function expandTilde(input: string, homedir: string): string {
  if (input === '~') return homedir;
  if (input.startsWith('~/')) return homedir + input.slice(1);
  return input;
}

// ─── lexicalNormalize ─────────────────────────────────────────────────────────

/**
 * Normalize a path lexically: resolve `.` and `..`, collapse multiple slashes,
 * remove trailing slash. Does NOT resolve symlinks.
 *
 * @deprecated No longer called in production — replaced by `normalizeLocal` from
 * `../util/local-path` (CHAMBA-015 wave 2). Kept as a public export to avoid a
 * breaking change; will be removed in the next minor release.
 */
export function lexicalNormalize(path: string): string {
  const parts = path.split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      out.pop();
    } else {
      out.push(p);
    }
  }
  const result = `/${out.join('/')}`;
  return result === '/' ? '/' : result;
}

// ─── SYSTEM_DIRS ─────────────────────────────────────────────────────────────

/**
 * System directories that cannot be used as vault dirs (exact match — subcategories
 * like `/tmp/mi-vault` are allowed). POSIX only; Windows paths are handled
 * separately in `prepareVaultDir` via the injected `platform`.
 */
export const SYSTEM_DIRS = new Set([
  '/',
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/var',
  '/tmp',
  '/opt',
  '/root',
  '/boot',
  '/dev',
  '/proc',
  '/sys',
  '/System',
  '/Library',
  '/private',
  '/private/etc',
  '/private/tmp',
  '/private/var',
  '/Volumes',
  '/mnt',
  '/media',
  '/Applications',
  '/Users',
  '/home',
]);

/**
 * Windows system directories (normalized to lowercase forward-slash, no trailing slash).
 * Checked case-insensitively with separators normalized.
 */
const WINDOWS_SYSTEM_DIRS_LOWER = new Set([
  'c:\\windows',
  'c:\\program files',
  'c:\\program files (x86)',
  'c:\\users',
  'c:/windows',
  'c:/program files',
  'c:/program files (x86)',
  'c:/users',
]);

function isWindowsRoot(path: string): boolean {
  // Match drive roots: C:\ or C: or C:/
  return /^[A-Za-z]:[/\\]?$/.test(path);
}

/**
 * Windows trees rejected together with everything under them (any drive letter):
 * `X:\Windows\…` and `X:\Program Files…\…` (covers `Program Files (x86)`).
 */
const WINDOWS_SYSTEM_TREE = /^[a-z]:\/(windows|program files[^/]*)(\/|$)/;

function isWindowsSystemDir(path: string): boolean {
  if (isWindowsRoot(path)) return true;
  const norm = path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return WINDOWS_SYSTEM_DIRS_LOWER.has(norm) || WINDOWS_SYSTEM_TREE.test(norm);
}

// ─── VaultDirValidationError ──────────────────────────────────────────────────

export type VaultDirValidationCode =
  | 'is_root'
  | 'is_home'
  | 'is_system'
  | 'in_repo'
  | 'already_linked'
  /**
   * Produced when the input path is a drive-relative path (`C:foo`, `C:` with no
   * separator) or a Windows device path (`\\?\…`, `\\.\…`). These are unambiguously
   * unsupported regardless of other validation steps.
   * Added in CHAMBA-015 (replaces the old `'unsupported_platform'` code).
   */
  | 'unsupported_path'
  /**
   * @deprecated Never produced by `prepareVaultDir` since CHAMBA-015.
   * Windows paths are now supported. Kept in the union to avoid a breaking
   * change to the public API.
   */
  | 'unsupported_platform';

export class VaultDirValidationError extends Error {
  override name = 'VaultDirValidationError';
  constructor(
    public readonly code: VaultDirValidationCode,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
  }
}

// ─── PrepareVaultDirOpts ──────────────────────────────────────────────────────

export interface PrepareVaultDirOpts {
  /** Raw user input (may include `~`, relative path, etc.). */
  input: string;
  homedir: string;
  cwd: string;
  slug: string;
  server: string;
  /** Allow the vault to live inside a git repo (adds `.chamba-sync/` to gitignore). */
  allowInRepo?: boolean;
  /** Already-resolved dirs for other vaults (to detect collisions). */
  existingLinks: Array<{ server: string; slug: string; dir: string }>;
  /**
   * Platform string (injected so core stays pure). Defaults to 'posix' (i.e.
   * not Windows). Pass `process.platform` from the adapter layer.
   */
  platform?: string;
}

export interface PrepareVaultDirResult {
  vaultDir: string;
  createdDir: boolean;
  gitignored: string[];
}

/**
 * Throw VaultDirValidationError when `path` is /, the home dir, or a system dir.
 * Used for both lex and canonical to catch symlink attacks.
 * On win32, comparisons are case-insensitive (via caseFoldLocal).
 */
function checkNotRootHomeOrSystem(
  path: string,
  homedir: string,
  _label: string,
  platform?: string,
): void {
  const style = detectStyle(platform ?? 'posix');
  const fold = (p: string) => caseFoldLocal(p, style);

  if (path === '/') {
    throw new VaultDirValidationError(
      'is_root',
      'No puedes usar el directorio raíz "/" como vault.',
    );
  }
  if (style === 'win32' && isWindowsRoot(path)) {
    throw new VaultDirValidationError(
      'is_system',
      `"${path}" es la raíz de una unidad de disco y no puede usarse como vault.`,
    );
  }
  if (fold(path) === fold(homedir)) {
    throw new VaultDirValidationError(
      'is_home',
      `No puedes usar tu carpeta de usuario "${homedir}" como vault.`,
    );
  }
  if (SYSTEM_DIRS.has(path)) {
    throw new VaultDirValidationError(
      'is_system',
      `"${path}" es un directorio del sistema y no puede usarse como vault.`,
    );
  }
  // Windows system dirs (case-insensitive)
  if (style === 'win32' && isWindowsSystemDir(path)) {
    throw new VaultDirValidationError(
      'is_system',
      `"${path}" es un directorio del sistema (Windows) y no puede usarse como vault.`,
    );
  }
  // Home-relative system dirs (POSIX)
  const homeDerived = [
    homedir,
    joinPath(homedir, 'Library'),
    joinPath(homedir, '.ssh'),
    joinPath(homedir, '.chamba'),
    joinPath(homedir, '.config'),
  ];
  if (homeDerived.map(fold).includes(fold(path))) {
    throw new VaultDirValidationError(
      'is_system',
      `"${path}" es una carpeta del sistema y no puede usarse como vault.`,
    );
  }
  // Windows home-derived dirs. `.ssh`, `.chamba` and `.config` are rejected exactly
  // (subfolders stay allowed, as on POSIX — e.g. `.chamba\vaults\x`); `AppData` is
  // rejected together with everything under it.
  if (style === 'win32') {
    const fPath = fold(path).replace(/\/+$/, '');
    const fHome = fold(homedir).replace(/\/+$/, '');
    const exact = ['.ssh', '.chamba', '.config'].map((d) => `${fHome}/${d}`);
    const appData = `${fHome}/appdata`;
    if (exact.includes(fPath) || fPath === appData || fPath.startsWith(`${appData}/`)) {
      throw new VaultDirValidationError(
        'is_system',
        `"${path}" es una carpeta del sistema y no puede usarse como vault.`,
      );
    }
  }
}

/**
 * Validate a candidate vault directory path, create it if it doesn't exist, and
 * return the canonical absolute path.
 *
 * Order of operations (per R2):
 * 1. expandTilde + absolutize against cwd if relative + normalizeLocal → lex
 * 2. String rejections on lex: is_root, is_home, is_system (no fs needed)
 * 3. canonical = fs.realpath(lex) — ENOENT-tolerant (returns lex if path not yet created)
 * 4. Re-check canonical (catches symlink attacks)
 * 5. Git root check via findGitRoot on canonical — if found and !allowInRepo → in_repo
 * 6. already_linked: compare canonical against fs.realpath(link.dir) for each existingLinks
 * 7. fs.mkdir(canonical) — first fs write; only happens after all validations pass
 * 8. If allowInRepo and had gitRoot: ensureVaultGitignored(fs, gitRoot, ['.chamba-sync/'])
 * 9. Return canonical
 */
export async function prepareVaultDir(
  deps: { fs: FilesystemPort },
  opts: PrepareVaultDirOpts,
): Promise<PrepareVaultDirResult> {
  const { fs } = deps;
  const {
    input,
    homedir,
    cwd,
    slug: _slug,
    server: _server,
    allowInRepo,
    existingLinks,
    platform,
  } = opts;

  const style = detectStyle(platform ?? 'posix');

  // Step 1: expand ~ + absolutize + lexical normalize using local-path helpers
  // (handles Windows drive letters and UNC paths — CHAMBA-015)
  const expanded = expandTilde(input, homedir);
  let absolute: string;
  let lex: string;
  try {
    absolute = toAbsoluteLocal(cwd, expanded, style);
    lex = normalizeLocal(absolute, style);
  } catch (pathErr) {
    // assertNotUnsupportedPath threw: drive-relative or device path — clear user error
    throw new VaultDirValidationError(
      'unsupported_path',
      pathErr instanceof Error ? pathErr.message : String(pathErr),
    );
  }

  // Step 2a: early string rejections on lex (no fs needed)
  checkNotRootHomeOrSystem(lex, homedir, 'lex', platform);

  // Step 2b: resolve canonical BEFORE mkdir — realpath is ENOENT-tolerant, so
  // if the path does not yet exist it returns the lexical path. Resolving here
  // catches symlinks that point to / or a system dir before we create anything.
  const canonical = await fs.realpath(lex);

  // Step 2c: re-check canonical (catches symlink attacks), using case-fold for win32
  const fold = (p: string) => caseFoldLocal(p, style);
  if (fold(canonical) !== fold(lex)) {
    checkNotRootHomeOrSystem(canonical, homedir, 'canonical', platform);
  }

  // Step 4: git root check — run on canonical path
  let gitRoot: string | null = null;
  gitRoot = await findGitRoot(fs, canonical, style);
  if (gitRoot !== null && !allowInRepo) {
    throw new VaultDirValidationError(
      'in_repo',
      `"${canonical}" está dentro de un repositorio git ("${gitRoot}"). ` +
        `Usa --allow-in-repo si es intencional.`,
      gitRoot,
    );
  }

  // Step 5: already_linked — compare canonical against realpath(link.dir), case-fold on win32
  for (const link of existingLinks) {
    const linkCanonical = await fs.realpath(link.dir);
    if (fold(linkCanonical) === fold(canonical)) {
      throw new VaultDirValidationError(
        'already_linked',
        `"${canonical}" ya está vinculado al vault "${link.slug}". Usa otra ruta.`,
        link.slug,
      );
    }
  }

  // Step 6: create directory (first fs write — only if all validations passed)
  const createdDir = !(await fs.exists(canonical));
  await fs.mkdir(canonical);

  // Step 9: gitignore if allowInRepo
  let gitignored: string[] = [];
  if (allowInRepo && gitRoot !== null) {
    gitignored = await ensureVaultGitignored(fs, gitRoot, ['.chamba-sync/']);
  }

  // Step 10: return canonical path
  return { vaultDir: canonical, createdDir, gitignored };
}
