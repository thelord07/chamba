import type { FilesystemPort } from '../ports/filesystem.js';
import { dirname, joinPath } from '../util/path.js';

/**
 * The files chamba writes into a vault, relative to the vault root. These must never
 * be committed — they're personal notes/memory. Used to keep a vault out of a repo
 * (gitignore backstop) and to explain what to move. Note: `.chamba/workspace.md` is
 * deliberately NOT here — that's project context the team may want to commit.
 */
export const VAULT_ARTIFACTS = [
  '.obsidian/',
  'Workspace overview.md',
  'proyectos/',
  'plans/',
  '.chamba/memory/',
];

/**
 * Walk up from `startPath` and return the first directory that contains a `.git`
 * (directory or gitdir file) — the git work-tree root — or null if the path isn't
 * inside a repo. Pure over `FilesystemPort`; no `git` process needed.
 */
export async function findGitRoot(fs: FilesystemPort, startPath: string): Promise<string | null> {
  let dir = startPath.replace(/[/\\]+$/, '');
  if (dir.length === 0) dir = '/';
  for (let i = 0; i < 64; i++) {
    if (await pathExists(fs, joinPath(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Which vault artifacts are NOT yet gitignored in `repoRoot` (read-only). Empty means
 * the vault is already protected — nothing of it can be committed.
 */
export async function vaultGitignoreMissing(
  fs: FilesystemPort,
  repoRoot: string,
): Promise<string[]> {
  const current = await readGitignore(fs, repoRoot);
  const present = new Set(
    current
      .split('\n')
      .map(normalizeIgnore)
      .filter((l) => l.length > 0),
  );
  return VAULT_ARTIFACTS.filter((p) => !present.has(normalizeIgnore(p)));
}

/** Compare gitignore patterns ignoring a leading/trailing slash (`/proyectos/` ≡ `proyectos`). */
function normalizeIgnore(pattern: string): string {
  return pattern.trim().replace(/^\//, '').replace(/\/$/, '');
}

/**
 * Ensure the vault artifacts are gitignored in `repoRoot`'s `.gitignore` (idempotent).
 * Appends only the patterns not already present, under a chamba-managed header. Returns
 * the patterns it added (empty when nothing was needed). A backstop so a vault that lives
 * inside a git repo can never be committed.
 */
export async function ensureVaultGitignored(
  fs: FilesystemPort,
  repoRoot: string,
): Promise<string[]> {
  const missing = await vaultGitignoreMissing(fs, repoRoot);
  if (missing.length === 0) return [];
  const current = await readGitignore(fs, repoRoot);
  const sep = current.length === 0 ? '' : current.endsWith('\n') ? '\n' : '\n\n';
  const block = `${sep}# chamba vault artifacts (personal notes/memory — kept out of git)\n${missing.join('\n')}\n`;
  await fs.writeFile(joinPath(repoRoot, '.gitignore'), current + block);
  return missing;
}

async function readGitignore(fs: FilesystemPort, repoRoot: string): Promise<string> {
  try {
    return await fs.readFile(joinPath(repoRoot, '.gitignore'));
  } catch {
    return '';
  }
}

async function pathExists(fs: FilesystemPort, path: string): Promise<boolean> {
  try {
    return await fs.exists(path);
  } catch {
    return false;
  }
}
