import type { FilesystemPort } from '../ports/filesystem.js';
import type { ProcessPort } from '../ports/process.js';
import { copyEnvFiles } from './env-copy.js';
import { WorktreeError } from './manager.js';
import type { WorktreePlanItem } from './multi-repo-plan.js';

export type WorktreeStatus =
  | 'created'
  | 'reused-local'
  | 'reused-remote'
  | 'skipped-exists'
  | 'skipped-not-git';

export interface MultiRepoWorktreeResult {
  repo: string;
  branch: string;
  worktreePath: string;
  status: WorktreeStatus;
  envCopied: number;
}

export interface CreateMultiInput {
  items: WorktreePlanItem[];
  baseBranch: string;
  copyEnvFiles: boolean;
  envPruneDirs: string[];
}

export interface CleanupMultiResult {
  repo: string;
  branch: string;
  removed: boolean;
  mergeSuggestion: string;
}

/**
 * Create and clean up git worktrees across several repos for one ticket.
 *
 * Mirrors the battle-tested manual flow: reuse an existing local/remote branch
 * or fork a new one from the base branch; optionally copy git-ignored `.env*`
 * files (worktrees don't carry untracked files). Same safety guarantees as the
 * single-repo manager: cleanup NEVER deletes branches and NEVER uses `--force`.
 */
export class MultiRepoWorktreeManager {
  constructor(
    private readonly process: ProcessPort,
    private readonly fs: FilesystemPort,
  ) {}

  async create(input: CreateMultiInput): Promise<MultiRepoWorktreeResult[]> {
    const results: MultiRepoWorktreeResult[] = [];
    for (const item of input.items) {
      results.push(await this.createOne(item, input));
    }
    return results;
  }

  private async createOne(
    item: WorktreePlanItem,
    input: CreateMultiInput,
  ): Promise<MultiRepoWorktreeResult> {
    const base = { repo: item.repo, branch: item.branch, worktreePath: item.worktreePath };

    if (!(await this.isGitRepo(item.repoPath))) {
      return { ...base, status: 'skipped-not-git', envCopied: 0 };
    }
    if (await this.fs.exists(item.worktreePath)) {
      return { ...base, status: 'skipped-exists', envCopied: 0 };
    }

    const status = await this.addWorktree(item, input.baseBranch);

    let envCopied = 0;
    if (input.copyEnvFiles) {
      envCopied = await copyEnvFiles(this.fs, item.repoPath, item.worktreePath, input.envPruneDirs);
    }

    return { ...base, status, envCopied };
  }

  private async addWorktree(item: WorktreePlanItem, baseBranch: string): Promise<WorktreeStatus> {
    const { repoPath, branch, worktreePath } = item;

    if (await this.branchExistsLocal(repoPath, branch)) {
      await this.git(repoPath, ['worktree', 'add', worktreePath, branch]);
      return 'reused-local';
    }

    if (await this.branchExistsRemote(repoPath, branch)) {
      await this.git(repoPath, ['fetch', 'origin', `${branch}:${branch}`]);
      await this.git(repoPath, ['worktree', 'add', worktreePath, branch]);
      return 'reused-remote';
    }

    // Best-effort fetch of the base branch, then fork a new branch from origin.
    await this.process.exec('git', ['fetch', 'origin', baseBranch], { cwd: repoPath });
    await this.git(repoPath, [
      'worktree',
      'add',
      '-b',
      branch,
      worktreePath,
      `origin/${baseBranch}`,
    ]);
    return 'created';
  }

  async cleanup(items: WorktreePlanItem[]): Promise<CleanupMultiResult[]> {
    const results: CleanupMultiResult[] = [];
    for (const item of items) {
      if (!(await this.fs.exists(item.worktreePath))) {
        results.push({
          repo: item.repo,
          branch: item.branch,
          removed: false,
          mergeSuggestion: this.mergeSuggestion(item),
        });
        continue;
      }
      // NO --force: a dirty worktree must fail loudly, not be discarded.
      const result = await this.process.exec('git', ['worktree', 'remove', item.worktreePath], {
        cwd: item.repoPath,
      });
      if (result.exitCode !== 0) {
        throw new WorktreeError(
          `git worktree remove failed for ${item.repo} (uncommitted changes?): ${result.stderr.trim() || 'unknown error'}`,
        );
      }
      results.push({
        repo: item.repo,
        branch: item.branch,
        removed: true,
        mergeSuggestion: this.mergeSuggestion(item),
      });
    }
    return results;
  }

  private mergeSuggestion(item: WorktreePlanItem): string {
    return `git -C ${item.repoPath} merge --no-ff ${item.branch}`;
  }

  private async isGitRepo(repoPath: string): Promise<boolean> {
    try {
      const entries = await this.fs.readDir(repoPath);
      return entries.some((e) => e.name === '.git' && e.isDirectory);
    } catch {
      return false;
    }
  }

  private async branchExistsLocal(repoPath: string, branch: string): Promise<boolean> {
    const result = await this.process.exec(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      { cwd: repoPath },
    );
    return result.exitCode === 0;
  }

  private async branchExistsRemote(repoPath: string, branch: string): Promise<boolean> {
    const result = await this.process.exec(
      'git',
      ['ls-remote', '--exit-code', '--heads', 'origin', branch],
      { cwd: repoPath },
    );
    return result.exitCode === 0;
  }

  private async git(repoPath: string, args: string[]): Promise<void> {
    const result = await this.process.exec('git', args, { cwd: repoPath });
    if (result.exitCode !== 0) {
      throw new WorktreeError(
        `git ${args.join(' ')} failed: ${result.stderr.trim() || 'unknown error'}`,
      );
    }
  }
}
