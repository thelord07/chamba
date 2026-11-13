export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessExecOptions {
  cwd?: string;
}

/**
 * CHAMBA-022: options for `ProcessPort.run` — spawn-based, with a ring
 * buffer and a hard timeout. `exec()` stays `execFile`-based and untouched;
 * `run` is additive (D-11) so the ~10 existing git callers never change.
 */
export interface ProcessRunOptions extends ProcessExecOptions {
  /** Hard wall-clock timeout. On expiry the adapter kills the WHOLE process tree. */
  timeoutMs?: number;
  /**
   * The EXACT env the child gets — the adapter never mixes it with
   * `process.env` unless the caller explicitly builds that in (O7). Absent
   * ⇒ adapter-defined default (an env allowlist for the Node adapter).
   */
  env?: Record<string, string>;
  /** Retention: keep only the last `tailLines` lines, capped at `maxBytes`. */
  capture?: { tailLines: number; maxBytes: number };
}

export interface ProcessRunResult extends ProcessResult {
  durationMs: number;
  /** The timeout fired and the adapter killed the process tree. */
  timedOut?: boolean;
  /**
   * Output was discarded by the retention cap. INFORMATIVE ONLY — never
   * implies failure (B4): the process still ran and exited on its own.
   */
  truncated?: boolean;
  /** POSIX signal name, set when the process was killed (e.g. by timeout). */
  signal?: string;
}

/**
 * Run external processes behind a port so `@chamba/core` never imports
 * `node:child_process`. Used from Phase 5 onward for git worktrees.
 */
export interface ProcessPort {
  exec(command: string, args: string[], options?: ProcessExecOptions): Promise<ProcessResult>;
  /**
   * Optional (D-11, precedent: `FilesystemPort.secureFile?`): spawn-based
   * execution with a ring buffer and timeout/tree-kill. A caller that needs
   * `run` (e.g. `chamba_task verify`) must check for its presence — not
   * every adapter implements it.
   */
  run?(command: string, args: string[], options?: ProcessRunOptions): Promise<ProcessRunResult>;
}
