import type { FilesystemPort } from '../ports/filesystem.js';
import { joinPath } from '../util/path.js';

export interface VaultDetection {
  found: boolean;
  path?: string;
  noteCount?: number;
}

export interface DetectOptions {
  /** Explicit vault path (e.g. from CHAMBA_OBSIDIAN_VAULT_PATH). Authoritative. */
  explicitPath?: string;
  /** Directories to probe for a `.obsidian/` marker when no explicit path. */
  searchRoots?: string[];
}

const COUNT_MAX_DEPTH = 8;
const SKIP_DIRS = new Set(['.obsidian', '.trash', 'node_modules', '.git']);

/**
 * Detect an Obsidian vault. An explicit path wins (the user set it on purpose);
 * otherwise probe common roots for a `.obsidian/` directory. `@chamba/core` has
 * no `os`/`fs`, so candidate roots are passed in by the caller.
 */
export class ObsidianDetector {
  constructor(private readonly fs: FilesystemPort) {}

  async detect(opts: DetectOptions): Promise<VaultDetection> {
    if (opts.explicitPath) {
      if (await this.fs.exists(opts.explicitPath)) {
        return {
          found: true,
          path: opts.explicitPath,
          noteCount: await this.countNotes(opts.explicitPath),
        };
      }
      return { found: false };
    }

    for (const root of opts.searchRoots ?? []) {
      if (await this.fs.exists(joinPath(root, '.obsidian'))) {
        return { found: true, path: root, noteCount: await this.countNotes(root) };
      }
    }
    return { found: false };
  }

  private async countNotes(vault: string): Promise<number> {
    let count = 0;
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > COUNT_MAX_DEPTH) return;
      let entries: Awaited<ReturnType<FilesystemPort['readDir']>>;
      try {
        entries = await this.fs.readDir(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory) {
          if (SKIP_DIRS.has(entry.name)) continue;
          await visit(joinPath(dir, entry.name), depth + 1);
        } else if (entry.name.toLowerCase().endsWith('.md')) {
          count++;
        }
      }
    };
    await visit(vault, 0);
    return count;
  }
}
