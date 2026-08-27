// Workspace-level worktree policy. Generic: the project-specific values
// (repos, root, branch prefix, base branch, env copy, editor workspace) all
// live in `.chamba/config.json`. No Node APIs, no LLM.

export type WorktreeLayout = 'sibling' | 'nested';

export interface WorktreePortsConfig {
  /** When false, chamba does not write `.env.local` or probe ports. */
  enabled: boolean;
  /** First PORT assigned to the first worktree. */
  base: number;
  /** Added for each subsequent worktree (and when a port is occupied). */
  step: number;
  /** Dotenv key written to `.env.local` (default `PORT`). */
  envKey: string;
}

export interface WorktreeOverlapConfig {
  /**
   * When true, `chamba_worktree_status` / `chamba_partition` report `ok: false`
   * if observed file overlap exists. Default false (warn, recommend sequential).
   */
  failOnOverlap: boolean;
}

export interface WorktreeConfig {
  /**
   * `sibling`: one folder per ticket under `<workspaceRoot>/<root>/<ticket>/<repo>`.
   * `nested`: a worktree under each repo at `<workspaceRoot>/<repo>/<root>/<ticket>`.
   */
  layout: WorktreeLayout;
  /** Worktree root: relative to workspace root (sibling) or to each repo (nested). */
  root: string;
  /** Branch prefix; the branch is `<branchPrefix><ticket>`, shared across repos. */
  branchPrefix: string;
  /** Branch to fork from when the ticket branch doesn't exist yet. */
  baseBranch: string;
  /** Copy git-ignored `.env*` files into the new worktree (off by default). */
  copyEnvFiles: boolean;
  /** Directories pruned while scanning for `.env*` files. */
  envPruneDirs: string[];
  /** Generate an editor workspace file (`.code-workspace`) for the ticket. */
  editorWorkspace: 'code-workspace' | null;
  /** Repos to act on; `null` means autodetect the workspace's git repos. */
  repos: string[] | null;
  /** Escape hatch: if set, chamba shells out to this command instead of the built-in. */
  command: string | null;
  /**
   * Hard cap on how many repos/workers the orchestrator runs in parallel.
   * `null` = auto (chamba sizes it from the machine's RAM/CPU).
   */
  maxParallel: number | null;
  /**
   * Estimated RAM per parallel worker, in MB, used to size safe parallelism.
   * `null` = the built-in default (2 GB). Lower it for light stacks.
   */
  perWorkerMemMB: number | null;
  /** Per-worktree PORT assignment (off by default). */
  ports: WorktreePortsConfig;
  /** Observed file-overlap policy. */
  overlap: WorktreeOverlapConfig;
}

export type PartialWorktreeConfig = Partial<Omit<WorktreeConfig, 'ports' | 'overlap'>> & {
  ports?: Partial<WorktreePortsConfig> | null;
  overlap?: Partial<WorktreeOverlapConfig>;
};

export const DEFAULT_WORKTREE_PORTS: WorktreePortsConfig = {
  enabled: false,
  base: 3000,
  step: 10,
  envKey: 'PORT',
};

export const DEFAULT_WORKTREE_OVERLAP: WorktreeOverlapConfig = {
  failOnOverlap: false,
};

export const DEFAULT_WORKTREE_CONFIG: WorktreeConfig = {
  layout: 'sibling',
  root: 'WORKTREES',
  branchPrefix: 'chamba/',
  baseBranch: 'main',
  copyEnvFiles: false,
  envPruneDirs: [
    'node_modules',
    '.git',
    '.next',
    'dist',
    'build',
    '.venv',
    'cdk.out',
    '.aws-sam',
    '.turbo',
    'coverage',
  ],
  editorWorkspace: null,
  repos: null,
  command: null,
  maxParallel: null,
  perWorkerMemMB: null,
  ports: { ...DEFAULT_WORKTREE_PORTS },
  overlap: { ...DEFAULT_WORKTREE_OVERLAP },
};

/** Deep-merge two on-disk partials (nested `ports` / `overlap`). */
export function mergeWorktreePartial(
  base: PartialWorktreeConfig,
  over: PartialWorktreeConfig,
): PartialWorktreeConfig {
  const ports =
    over.ports === null
      ? null
      : over.ports !== undefined
        ? { ...(base.ports ?? {}), ...over.ports }
        : base.ports;
  const overlap =
    over.overlap !== undefined ? { ...(base.overlap ?? {}), ...over.overlap } : base.overlap;
  return { ...base, ...over, ports, overlap };
}

/** Merge a partial (on-disk) worktree config over the compiled defaults. */
export function resolveWorktreeConfig(file?: PartialWorktreeConfig): WorktreeConfig {
  const d = DEFAULT_WORKTREE_CONFIG;
  if (!file) {
    return {
      ...d,
      envPruneDirs: [...d.envPruneDirs],
      ports: { ...d.ports },
      overlap: { ...d.overlap },
    };
  }
  return {
    layout: file.layout ?? d.layout,
    root: file.root ?? d.root,
    branchPrefix: file.branchPrefix ?? d.branchPrefix,
    baseBranch: file.baseBranch ?? d.baseBranch,
    copyEnvFiles: file.copyEnvFiles ?? d.copyEnvFiles,
    envPruneDirs: file.envPruneDirs ?? d.envPruneDirs,
    editorWorkspace: file.editorWorkspace !== undefined ? file.editorWorkspace : d.editorWorkspace,
    repos: file.repos !== undefined ? file.repos : d.repos,
    command: file.command !== undefined ? file.command : d.command,
    maxParallel: file.maxParallel !== undefined ? file.maxParallel : d.maxParallel,
    perWorkerMemMB: file.perWorkerMemMB !== undefined ? file.perWorkerMemMB : d.perWorkerMemMB,
    ports: resolvePorts(file.ports),
    overlap: {
      failOnOverlap: file.overlap?.failOnOverlap ?? d.overlap.failOnOverlap,
    },
  };
}

function resolvePorts(file?: Partial<WorktreePortsConfig> | null): WorktreePortsConfig {
  const d = DEFAULT_WORKTREE_PORTS;
  if (!file) return { ...d };
  return {
    enabled: file.enabled ?? d.enabled,
    base: file.base ?? d.base,
    step: file.step ?? d.step,
    envKey: file.envKey ?? d.envKey,
  };
}
