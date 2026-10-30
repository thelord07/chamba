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

function isWindowsSystemDir(path: string): boolean {
  if (isWindowsRoot(path)) return true;
  const norm = path.replace(/\\/g, '/').toLowerCase();
  return WINDOWS_SYSTEM_DIRS_LOWER.has(norm);
}

// ─── VaultDirValidationError ──────────────────────────────────────────────────

export type VaultDirValidationCode =
  | 'is_root'
  | 'is_home'
  | 'is_system'
  | 'in_repo'
  | 'already_linked'
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
 */
function checkNotRootHomeOrSystem(path: string, homedir: string, _label: string): void {
  if (path === '/') {
    throw new VaultDirValidationError(
      'is_root',
      'No puedes usar el directorio raíz "/" como vault.',
    );
  }
  if (path === homedir) {
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
  // Home-relative system dirs
  const homeDerived = [
    homedir,
    joinPath(homedir, 'Library'),
    joinPath(homedir, '.ssh'),
    joinPath(homedir, '.chamba'),
    joinPath(homedir, '.config'),
  ];
  if (homeDerived.includes(path)) {
    throw new VaultDirValidationError(
      'is_system',
      `"${path}" es una carpeta del sistema y no puede usarse como vault.`,
    );
  }
}

/**
 * Validate a candidate vault directory path, create it if it doesn't exist, and
 * return the canonical absolute path.
 *
 * Order of operations (per R2):
 * 1. expandTilde + Windows check + absolutize against cwd if relative + lexicalNormalize → lex
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

  // Step 1: expand ~ + absolutize + lexical normalize
  const expanded = expandTilde(input, homedir);

  // Step 3 (early): Windows system-dir check on the raw expanded path (before POSIX normalization)
  // since Windows paths are not valid POSIX paths.
  if (platform === 'win32') {
    if (isWindowsSystemDir(expanded)) {
      throw new VaultDirValidationError(
        'is_system',
        `"${expanded}" es un directorio del sistema (Windows) y no puede usarse como vault.`,
      );
    }
    // Also check Windows home-derived dirs
    const winHomeDerived = [
      homedir,
      `${homedir}\\Library`,
      `${homedir}\\.ssh`,
      `${homedir}\\.chamba`,
      `${homedir}\\.config`,
      `${homedir}/Library`,
      `${homedir}/.ssh`,
      `${homedir}/.chamba`,
      `${homedir}/.config`,
    ];
    const normalizedExpanded = expanded.replace(/\\/g, '/').toLowerCase();
    if (winHomeDerived.some((d) => d.replace(/\\/g, '/').toLowerCase() === normalizedExpanded)) {
      throw new VaultDirValidationError(
        'is_system',
        `"${expanded}" es una carpeta del sistema y no puede usarse como vault.`,
      );
    }

    // Windows absolute path (drive letter + colon): can't be handled cleanly
    // with the current POSIX-only FilesystemPort. Throw unsupported_platform.
    if (/^[A-Za-z]:[/\\]/.test(expanded) || /^[A-Za-z]:$/.test(expanded)) {
      throw new VaultDirValidationError(
        'unsupported_platform',
        `La ruta "${expanded}" es una ruta absoluta de Windows. El soporte nativo de rutas ` +
          `Windows aún no está disponible en esta versión. Usa una ruta relativa o reporta ` +
          `este caso en https://github.com/chamba-dev/chamba.`,
      );
    }
  }

  const absolute = expanded.startsWith('/') ? expanded : joinPath(cwd, expanded);
  const lex = lexicalNormalize(absolute);

  // Step 2a: early string rejections on lex (no fs needed)
  checkNotRootHomeOrSystem(lex, homedir, 'lex');

  // Step 2b: resolve canonical BEFORE mkdir — realpath is ENOENT-tolerant, so
  // if the path does not yet exist it returns the lexical path. Resolving here
  // catches symlinks that point to / or a system dir before we create anything.
  const canonical = await fs.realpath(lex);

  // Step 2c: re-check canonical (catches symlink attacks)
  if (canonical !== lex) {
    checkNotRootHomeOrSystem(canonical, homedir, 'canonical');
  }

  // Step 4: git root check — run on canonical path
  let gitRoot: string | null = null;
  gitRoot = await findGitRoot(fs, canonical);
  if (gitRoot !== null && !allowInRepo) {
    throw new VaultDirValidationError(
      'in_repo',
      `"${canonical}" está dentro de un repositorio git ("${gitRoot}"). ` +
        `Usa --allow-in-repo si es intencional.`,
      gitRoot,
    );
  }

  // Step 5: already_linked — compare canonical against realpath(link.dir) for each link
  for (const link of existingLinks) {
    const linkCanonical = await fs.realpath(link.dir);
    if (linkCanonical === canonical) {
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
