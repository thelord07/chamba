import type { ProcessPort } from '../ports/process.js';
import { parseMergeTreeOutput } from './merge-tree.js';

export type ConflictPreviewMode = 'name-only' | 'classic' | 'failed';

export interface ConflictPair {
  /** Left ref (usually the base branch or a sibling topic). */
  left: string;
  /** Right ref (usually a worktree branch). */
  right: string;
  files: string[];
  mode: ConflictPreviewMode;
  error?: string;
}

export interface ConflictPreviewReport {
  repoRoot: string;
  baseBranch: string;
  vsBase: ConflictPair[];
  pairwise: ConflictPair[];
}

/**
 * Dry-run merge conflicts with `git merge-tree`. NEVER runs `git merge`.
 */
export class ConflictPreviewer {
  constructor(private readonly process: ProcessPort) {}

  async preview(repoRoot: string, left: string, right: string): Promise<ConflictPair> {
    if (left === right) {
      return { left, right, files: [], mode: 'name-only' };
    }
    const modern = await this.process.exec('git', ['merge-tree', '--name-only', left, right], {
      cwd: repoRoot,
    });
    // Git 2.38+: exit 0 = clean, 1 = conflicts listed. Only fall back when the
    // flag itself is unsupported (old git) or the refs are missing.
    const nameOnlyUnsupported = /unknown option|unknown switch|usage:/i.test(modern.stderr);
    if (!nameOnlyUnsupported && (modern.exitCode === 0 || modern.exitCode === 1)) {
      return {
        left,
        right,
        files: parseMergeTreeOutput(modern.stdout, 'name-only'),
        mode: 'name-only',
      };
    }

    const base = await this.process.exec('git', ['merge-base', left, right], { cwd: repoRoot });
    if (base.exitCode !== 0) {
      return {
        left,
        right,
        files: [],
        mode: 'failed',
        error: base.stderr.trim() || modern.stderr.trim() || 'merge-base failed',
      };
    }
    const classic = await this.process.exec(
      'git',
      ['merge-tree', base.stdout.trim(), left, right],
      { cwd: repoRoot },
    );
    if (classic.exitCode !== 0 && classic.stdout.trim().length === 0) {
      return {
        left,
        right,
        files: [],
        mode: 'failed',
        error: classic.stderr.trim() || 'merge-tree failed',
      };
    }
    return {
      left,
      right,
      files: parseMergeTreeOutput(classic.stdout, 'classic'),
      mode: 'classic',
    };
  }

  /**
   * Conflicts of each topic branch against `baseBranch`, plus pairwise among
   * the topics. Skips empty/duplicate names. Never merges.
   */
  async previewBranches(
    repoRoot: string,
    branches: string[],
    baseBranch: string,
  ): Promise<ConflictPreviewReport> {
    const topics = uniqueKeep(branches.filter((b) => b.length > 0 && b !== baseBranch));
    const vsBase: ConflictPair[] = [];
    for (const b of topics) {
      vsBase.push(await this.preview(repoRoot, baseBranch, b));
    }
    const pairwise: ConflictPair[] = [];
    for (let i = 0; i < topics.length; i++) {
      const a = topics[i];
      if (!a) continue;
      for (let j = i + 1; j < topics.length; j++) {
        const b = topics[j];
        if (!b) continue;
        pairwise.push(await this.preview(repoRoot, a, b));
      }
    }
    return { repoRoot, baseBranch, vsBase, pairwise };
  }
}

function uniqueKeep(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}
