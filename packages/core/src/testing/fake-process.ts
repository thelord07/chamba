import type {
  ProcessExecOptions,
  ProcessPort,
  ProcessResult,
  ProcessRunOptions,
  ProcessRunResult,
} from '../ports/process.js';

export interface RecordedCall {
  command: string;
  args: string[];
  cwd?: string;
}

export type ProcessHandler = (
  command: string,
  args: string[],
  options?: ProcessExecOptions,
) => Partial<ProcessResult>;

export type ProcessRunHandler = (
  command: string,
  args: string[],
  options?: ProcessRunOptions,
) => Partial<ProcessRunResult>;

/**
 * In-memory `ProcessPort` for tests. Records every call and returns whatever the
 * handler produces (defaults to exit 0, empty output).
 *
 * `run()` is implemented too (CHAMBA-022) so tests of callers that require
 * `ProcessPort.run` (e.g. `verify-runner`) don't need a real adapter.
 */
export class FakeProcess implements ProcessPort {
  readonly calls: RecordedCall[] = [];
  readonly runCalls: RecordedCall[] = [];

  constructor(
    private readonly handler: ProcessHandler = () => ({}),
    private readonly runHandler: ProcessRunHandler = () => ({}),
  ) {}

  async exec(
    command: string,
    args: string[],
    options?: ProcessExecOptions,
  ): Promise<ProcessResult> {
    this.calls.push({ command, args, cwd: options?.cwd });
    const out = this.handler(command, args, options);
    return { stdout: out.stdout ?? '', stderr: out.stderr ?? '', exitCode: out.exitCode ?? 0 };
  }

  async run(
    command: string,
    args: string[],
    options?: ProcessRunOptions,
  ): Promise<ProcessRunResult> {
    this.runCalls.push({ command, args, cwd: options?.cwd });
    const out = this.runHandler(command, args, options);
    return {
      stdout: out.stdout ?? '',
      stderr: out.stderr ?? '',
      exitCode: out.exitCode ?? 0,
      durationMs: out.durationMs ?? 0,
      ...(out.timedOut !== undefined ? { timedOut: out.timedOut } : {}),
      ...(out.truncated !== undefined ? { truncated: out.truncated } : {}),
      ...(out.signal !== undefined ? { signal: out.signal } : {}),
    };
  }
}
