import type { ProcessExecOptions, ProcessPort, ProcessResult } from '../ports/process.js';

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

/**
 * In-memory `ProcessPort` for tests. Records every call and returns whatever the
 * handler produces (defaults to exit 0, empty output).
 */
export class FakeProcess implements ProcessPort {
  readonly calls: RecordedCall[] = [];

  constructor(private readonly handler: ProcessHandler = () => ({})) {}

  async exec(
    command: string,
    args: string[],
    options?: ProcessExecOptions,
  ): Promise<ProcessResult> {
    this.calls.push({ command, args, cwd: options?.cwd });
    const out = this.handler(command, args, options);
    return { stdout: out.stdout ?? '', stderr: out.stderr ?? '', exitCode: out.exitCode ?? 0 };
  }
}
