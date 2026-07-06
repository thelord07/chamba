import type { ProcessPort } from '@chamba/core';

/**
 * Read `origin`'s URL so vault notes can be grouped by project. Returns
 * `undefined` outside a git repo, with no remote, or if git isn't available —
 * callers then fall back to the flat vault layout. Never throws.
 */
export async function readGitRemote(
  process: ProcessPort,
  cwd: string,
): Promise<string | undefined> {
  try {
    const res = await process.exec('git', ['remote', 'get-url', 'origin'], { cwd });
    const url = res.stdout.trim();
    return res.exitCode === 0 && url.length > 0 ? url : undefined;
  } catch {
    return undefined;
  }
}
