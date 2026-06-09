import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProcessExecOptions, ProcessPort, ProcessResult } from '@chamba/core';

const execFileAsync = promisify(execFile);

/** Node-backed `ProcessPort` using `execFile` (no shell, args passed as array). */
export class NodeProcess implements ProcessPort {
  async exec(
    command: string,
    args: string[],
    options?: ProcessExecOptions,
  ): Promise<ProcessResult> {
    try {
      const { stdout, stderr } = await execFileAsync(command, args, { cwd: options?.cwd });
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      // execFile rejects with an error carrying stdout/stderr/code on non-zero exit.
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      return {
        stdout: e.stdout ?? '',
        stderr: e.stderr ?? e.message ?? String(err),
        exitCode: typeof e.code === 'number' ? e.code : 1,
      };
    }
  }
}
