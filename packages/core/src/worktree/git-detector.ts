import type { ProcessPort } from '../ports/process.js';

/**
 * Detect whether a directory is inside a git work tree, via
 * `git rev-parse --is-inside-work-tree`. Caches per root for the session.
 */
export class GitDetector {
  private readonly cache = new Map<string, boolean>();

  constructor(private readonly process: ProcessPort) {}

  async isGitRepo(root: string): Promise<boolean> {
    const cached = this.cache.get(root);
    if (cached !== undefined) return cached;

    const result = await this.process.exec('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: root,
    });
    const isRepo = result.exitCode === 0 && result.stdout.trim() === 'true';
    this.cache.set(root, isRepo);
    return isRepo;
  }
}
