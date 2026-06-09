export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessExecOptions {
  cwd?: string;
}

/**
 * Run external processes behind a port so `@chamba/core` never imports
 * `node:child_process`. Used from Phase 5 onward for git worktrees.
 */
export interface ProcessPort {
  exec(command: string, args: string[], options?: ProcessExecOptions): Promise<ProcessResult>;
}
