import type { FilesystemPort } from '../ports/filesystem.js';
import { dirname, joinPath } from '../util/path.js';

/** A git-ignored env file we want to carry into the worktree (not an example/backup). */
function isEnvFile(name: string): boolean {
  if (name !== '.env' && !name.startsWith('.env.')) return false;
  if (/\.(example|sample)$/i.test(name)) return false;
  if (/\.bak(\.|$)/i.test(name)) return false;
  return true;
}

/**
 * Copy git-ignored `.env*` files from `src` into `dst`, preserving relative
 * paths (so nested ones land in the right subdir). Worktrees share the repo's
 * tracked files but NOT untracked/ignored ones, so without this a local `.env`
 * would be missing. Heavy/generated dirs in `pruneDirs` are skipped. Returns the
 * number of files copied.
 */
export async function copyEnvFiles(
  fs: FilesystemPort,
  src: string,
  dst: string,
  pruneDirs: string[],
): Promise<number> {
  const prune = new Set(pruneDirs);
  let count = 0;

  const walk = async (rel: string): Promise<void> => {
    const abs = rel.length > 0 ? joinPath(src, rel) : src;
    let entries: Awaited<ReturnType<FilesystemPort['readDir']>>;
    try {
      entries = await fs.readDir(abs);
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel.length > 0 ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (prune.has(entry.name)) continue;
        await walk(childRel);
      } else if (isEnvFile(entry.name)) {
        const content = await fs.readFile(joinPath(src, childRel));
        const target = joinPath(dst, childRel);
        await fs.mkdir(dirname(target));
        await fs.writeFile(target, content);
        count++;
      }
    }
  };

  await walk('');
  return count;
}
