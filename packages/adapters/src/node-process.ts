import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  ProcessExecOptions,
  ProcessPort,
  ProcessResult,
  ProcessRunOptions,
  ProcessRunResult,
} from '@chamba/core';
import { tailRing } from '@chamba/core';
import { resolveExecutable, UnsafeArgError } from './resolve-executable.js';

const execFileAsync = promisify(execFile);

const DEFAULT_CAPTURE = { tailLines: 200, maxBytes: 256 * 1024 };
/** Grace period between SIGTERM and SIGKILL on POSIX (B5). */
const KILL_GRACE_MS = 3000;

/** O7 default allowlist — used ONLY when the caller passes no `env` at all. */
const ENV_ALLOWLIST_EXACT = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'TMPDIR',
  'ComSpec',
  'PATHEXT',
  'LANG',
  'LC_ALL',
  'TZ',
  'CI',
]);
const ENV_ALLOWLIST_PREFIXES = ['NODE_', 'npm_config_'];

function defaultEnvAllowlist(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (ENV_ALLOWLIST_EXACT.has(key) || ENV_ALLOWLIST_PREFIXES.some((p) => key.startsWith(p))) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Bounded accumulator over a process's stdout/stderr: appends chunks as they
 * arrive, periodically compacting with `tailRing` so memory never grows
 * unboundedly even for pathological (hundreds-of-MB) output. The process
 * itself is NEVER paused/killed because of volume — only `truncated`
 * (informative) is affected (B4).
 */
class RingAccumulator {
  private text = '';
  private truncatedSoFar = false;

  constructor(
    private readonly tailLines: number,
    private readonly maxBytes: number,
  ) {}

  push(chunk: string): void {
    this.text += chunk;
    // Compact well before the buffer could grow unbounded.
    if (this.text.length > this.maxBytes * 4 + 65_536) {
      this.compact();
    }
  }

  private compact(): void {
    const result = tailRing([this.text], { lines: this.tailLines, maxBytes: this.maxBytes });
    if (result.truncated) this.truncatedSoFar = true;
    this.text = result.text;
  }

  finish(): { text: string; truncated: boolean } {
    this.compact();
    return { text: this.text, truncated: this.truncatedSoFar };
  }
}

/** POSIX: SIGTERM/SIGKILL the whole process group. Windows: `taskkill /T /F`. */
function killTree(pid: number, isWin: boolean, forceKill: boolean): void {
  if (isWin) {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { shell: false });
    } catch {
      // NN3: already dead (ESRCH-equivalent) — nothing to do.
    }
    return;
  }
  try {
    process.kill(-pid, forceKill ? 'SIGKILL' : 'SIGTERM');
  } catch (err) {
    // NN3: ESRCH means the tree is already gone — safe to ignore. Any other
    // error is equally unactionable here (we're in a timeout callback).
    void err;
  }
}

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

  /**
   * CHAMBA-022 (B4/B5): spawn-based execution with a ring-buffered
   * stdout/stderr and a hard timeout that kills the WHOLE process tree
   * (never just the direct child — `pnpm test` → `vitest` would otherwise
   * survive). Never uses `shell: true` — `resolveExecutable` is the only
   * place a second process (`cmd.exe`) is ever introduced, and only with a
   * validated argv.
   */
  async run(
    command: string,
    args: string[],
    options: ProcessRunOptions = {},
  ): Promise<ProcessRunResult> {
    const cwd = options.cwd ?? process.cwd();
    const capture = options.capture ?? DEFAULT_CAPTURE;
    const isWin = process.platform === 'win32';
    const start = Date.now();

    let resolved: ReturnType<typeof resolveExecutable>;
    try {
      resolved = resolveExecutable(command, args, cwd);
    } catch (err) {
      // N4: an `UnsafeArgError` (an arg rejected by the `.cmd`/`.bat`
      // allowlist, O4) is a SECURITY refusal, not an ordinary command
      // failure — tag it distinctly so evidence/logs never read it as "the
      // test failed with exit 1" (resolution failures otherwise look
      // identical: same exitCode, same stderr shape).
      const message = err instanceof Error ? err.message : String(err);
      return {
        stdout: '',
        stderr: err instanceof UnsafeArgError ? `[bloqueado por seguridad] ${message}` : message,
        exitCode: 1,
        durationMs: Date.now() - start,
      };
    }

    const env = options.env ?? defaultEnvAllowlist();

    return new Promise<ProcessRunResult>((resolvePromise) => {
      const child = spawn(resolved.file, resolved.args, {
        cwd,
        env,
        windowsHide: true,
        shell: false,
        detached: !isWin,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdoutAcc = new RingAccumulator(capture.tailLines, capture.maxBytes);
      const stderrAcc = new RingAccumulator(capture.tailLines, capture.maxBytes);
      let timedOut = false;
      let signal: string | undefined;
      let settled = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      let graceHandle: ReturnType<typeof setTimeout> | undefined;

      child.stdout?.on('data', (chunk: Buffer) => stdoutAcc.push(chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => stderrAcc.push(chunk.toString('utf8')));

      const settle = (exitCode: number, exitSignal?: string | null): void => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (graceHandle) clearTimeout(graceHandle);
        const out = stdoutAcc.finish();
        const errOut = stderrAcc.finish();
        resolvePromise({
          stdout: out.text,
          stderr: errOut.text,
          exitCode,
          durationMs: Date.now() - start,
          ...(timedOut ? { timedOut: true } : {}),
          ...(out.truncated || errOut.truncated ? { truncated: true } : {}),
          ...((signal ?? exitSignal) ? { signal: (signal ?? exitSignal) as string } : {}),
        });
      };

      child.on('error', (err) => {
        stderrAcc.push(err.message ?? String(err));
        settle(1);
      });

      // `close` (not `exit`) — fires only once stdout/stderr have been fully
      // drained, so the last chunk of output is never missed under load.
      child.on('close', (code, exitSignal) => {
        settle(code ?? (exitSignal ? 1 : 0), exitSignal);
      });

      if (options.timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          if (child.pid !== undefined) killTree(child.pid, isWin, false);
          if (!isWin) {
            graceHandle = setTimeout(() => {
              if (!settled && child.pid !== undefined) {
                signal = 'SIGKILL';
                killTree(child.pid, isWin, true);
              }
            }, KILL_GRACE_MS);
          } else {
            signal = 'SIGKILL';
          }
        }, options.timeoutMs);
      }
    });
  }
}
