import type { ClockPort } from '../ports/clock.js';
import type { FilesystemPort } from '../ports/filesystem.js';
import type { ProcessPort } from '../ports/process.js';
import { joinPath } from '../util/path.js';
import { detectGitRepos } from './git-repo-detector.js';
import type { FileOverlap } from './overlap.js';
import { findOverlaps } from './overlap.js';
import type { ListedWorktree } from './porcelain.js';
import { parseWorktreePorcelain } from './porcelain.js';
import { parseLeftRightCount, parseNameOnly, parseStatusPaths, unique } from './status-files.js';

/** A linked worktree with no unique commits for this long, and a clean tree, is stale. */
export const WORKTREE_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface WorktreeSnapshot {
  path: string;
  head?: string;
  branch?: string;
  /** First porcelain entry — the main checkout. Never reported stale. */
  primary: boolean;
  dirty: boolean;
  changedFiles: string[];
  ahead: number | null;
  behind: number | null;
  /** Commits on HEAD not in upstream; `null` when there is no upstream. */
  unpushed: number | null;
  lastCommitAt: string | null;
  stale: boolean;
  notes: string[];
}

export interface WorktreeInspection {
  repoRoot: string;
  baseBranch: string;
  worktrees: WorktreeSnapshot[];
  overlaps: FileOverlap[];
}

/**
 * Read-only snapshot of a repo's worktrees. Git status is the source of truth —
 * no registry, no heartbeats. Never merges.
 */
export class WorktreeInspector {
  constructor(
    private readonly process: ProcessPort,
    private readonly clock: ClockPort,
  ) {}

  async inspect(
    repoRoot: string,
    opts: { baseBranch?: string; staleAfterMs?: number } = {},
  ): Promise<WorktreeInspection> {
    const baseBranch = opts.baseBranch ?? 'main';
    const staleAfterMs = opts.staleAfterMs ?? WORKTREE_STALE_AFTER_MS;
    const listed = await this.list(repoRoot);
    const worktrees: WorktreeSnapshot[] = [];
    for (let i = 0; i < listed.length; i++) {
      const w = listed[i];
      if (!w) continue;
      worktrees.push(await this.snapshot(w, i === 0, baseBranch, staleAfterMs));
    }
    const overlaps = findOverlaps(
      worktrees.map((w) => ({ id: w.branch ?? w.path, paths: w.changedFiles })),
    );
    return { repoRoot, baseBranch, worktrees, overlaps };
  }

  private async list(repoRoot: string): Promise<ListedWorktree[]> {
    const result = await this.git(repoRoot, ['worktree', 'list', '--porcelain']);
    if (result.exitCode !== 0) return [];
    return parseWorktreePorcelain(result.stdout);
  }

  private async snapshot(
    listed: ListedWorktree,
    primary: boolean,
    baseBranch: string,
    staleAfterMs: number,
  ): Promise<WorktreeSnapshot> {
    const notes: string[] = [];
    const status = await this.git(listed.path, ['status', '--porcelain']);
    const dirty = status.exitCode === 0 && status.stdout.trim().length > 0;
    const statusPaths = status.exitCode === 0 ? parseStatusPaths(status.stdout) : [];

    const range = `${baseBranch}...HEAD`;
    const counts = await this.git(listed.path, ['rev-list', '--left-right', '--count', range]);
    const parsed = counts.exitCode === 0 ? parseLeftRightCount(counts.stdout) : undefined;
    if (counts.exitCode !== 0) notes.push(`base '${baseBranch}' missing or unborn`);

    const log = await this.git(listed.path, ['log', '-1', '--format=%cI']);
    const lastCommitAt =
      log.exitCode === 0 && log.stdout.trim().length > 0 ? log.stdout.trim() : null;

    const committed = await this.names(listed.path, ['diff', '--name-only', range]);
    const unstaged = await this.names(listed.path, ['diff', '--name-only']);
    const staged = await this.names(listed.path, ['diff', '--name-only', '--cached']);
    const changedFiles = unique([...committed, ...unstaged, ...staged, ...statusPaths]);

    const unpushed = await this.unpushedCount(listed.path);

    const ahead = parsed?.ahead ?? null;
    const stale = isStale({
      primary,
      dirty,
      ahead,
      lastCommitAt,
      now: this.clock.now(),
      staleAfterMs,
    });

    return {
      path: listed.path,
      head: listed.head,
      branch: listed.branch,
      primary,
      dirty,
      changedFiles,
      ahead,
      behind: parsed?.behind ?? null,
      unpushed,
      lastCommitAt,
      stale,
      notes,
    };
  }

  private async unpushedCount(cwd: string): Promise<number | null> {
    const up = await this.git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (up.exitCode !== 0) return null;
    const count = await this.git(cwd, ['rev-list', '--count', '@{u}..HEAD']);
    if (count.exitCode !== 0) return null;
    const n = Number(count.stdout.trim());
    return Number.isFinite(n) ? n : null;
  }

  private async names(cwd: string, args: string[]): Promise<string[]> {
    const result = await this.git(cwd, args);
    if (result.exitCode !== 0) return [];
    return parseNameOnly(result.stdout);
  }

  private git(cwd: string, args: string[]) {
    return this.process.exec('git', args, { cwd });
  }
}

export function isStale(input: {
  primary: boolean;
  dirty: boolean;
  ahead: number | null;
  lastCommitAt: string | null;
  now: Date;
  staleAfterMs: number;
}): boolean {
  if (input.primary) return false;
  if (input.dirty) return false;
  if (input.ahead == null || input.ahead <= 0) return false;
  if (!input.lastCommitAt) return false;
  const t = Date.parse(input.lastCommitAt);
  if (!Number.isFinite(t)) return false;
  return input.now.getTime() - t >= input.staleAfterMs;
}

export async function inspectRepos(input: {
  inspector: WorktreeInspector;
  fs: FilesystemPort;
  cwd: string;
  repos?: string[];
  baseBranch: string;
}): Promise<WorktreeInspection[]> {
  const names =
    input.repos && input.repos.length > 0 ? input.repos : await detectGitRepos(input.fs, input.cwd);
  const roots =
    names.length > 0
      ? names.map((n) => (n.startsWith('/') ? n : joinPath(input.cwd, n)))
      : [input.cwd];
  const out: WorktreeInspection[] = [];
  for (const root of roots) {
    out.push(await input.inspector.inspect(root, { baseBranch: input.baseBranch }));
  }
  return out;
}
