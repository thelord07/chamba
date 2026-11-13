/**
 * resolve-executable.ts — CHAMBA-022 (O4)
 *
 * Portable, shell-free resolution of the executable `chamba_task verify`
 * should spawn. `spawn`/`execFile` reject `.cmd`/`.bat` files outright
 * (Node ≥ 20, no shell) — `resolveExecutable` detects that case and routes
 * it through `cmd.exe /d /s /c` explicitly, validating every arg against an
 * ALLOWLIST of characters (never a denylist) before it ever touches the
 * child process. `shell: true` is never used, in any branch.
 *
 * Resolution order:
 *   1. `command` contains a path separator → resolve against `cwd`.
 *   2. `<cwd>/node_modules/.bin/<command>` (+ `.cmd`/`.exe`/`.bat` on Windows).
 *   3. PATH, respecting `PATHEXT` on Windows.
 *   4. Fallback: the bare `command` (let `spawn` surface ENOENT).
 *
 * `platform`/`env`/`exists` are injectable so the resolution logic itself
 * (not real filesystem/PATH lookups) can be exercised deterministically on
 * any OS — a test can simulate `platform: 'win32'` from a macOS/Linux CI
 * runner without needing a real Windows machine.
 */

import { existsSync } from 'node:fs';
import { posix as posixPath, win32 as win32Path } from 'node:path';

/** Characters allowed in an arg passed through `cmd.exe /d /s /c` (ALLOWLIST, not a denylist). */
const WINDOWS_ARG_ALLOWLIST = /^[A-Za-z0-9._:\\/@=+\- ]*$/;

export class UnsafeArgError extends Error {
  constructor(arg: string) {
    super(
      `el argumento "${arg}" contiene un carácter no permitido al ejecutar un .cmd/.bat vía cmd.exe.`,
    );
    this.name = 'UnsafeArgError';
  }
}

export interface ResolvedExecutable {
  /** The actual file to `spawn`. */
  file: string;
  /** Args to pass to `spawn`, possibly rewritten for the `cmd.exe` branch. */
  args: string[];
  /** True when `file` is `cmd.exe`/`ComSpec` wrapping a `.cmd`/`.bat` target. */
  viaComSpec: boolean;
}

export interface ResolveExecutableDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

function candidateExtensions(isWin: boolean, env: NodeJS.ProcessEnv): string[] {
  if (!isWin) return [''];
  const pathext = env.PATHEXT;
  const exts = pathext
    ? pathext.split(';').filter((e) => e.length > 0)
    : ['.COM', '.EXE', '.BAT', '.CMD'];
  return [...exts, '']; // also try the bare name (already has an extension, or none needed)
}

function findExecutable(
  base: string,
  isWin: boolean,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
): string | undefined {
  for (const ext of candidateExtensions(isWin, env)) {
    const candidate = ext === '' ? base : `${base}${ext}`;
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

function findOnPath(
  command: string,
  isWin: boolean,
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean,
  pathApi: typeof posixPath,
): string | undefined {
  const pathEnv = env.PATH ?? env.Path ?? '';
  for (const dir of pathEnv.split(pathApi.delimiter).filter((d) => d.length > 0)) {
    const found = findExecutable(pathApi.join(dir, command), isWin, env, exists);
    if (found) return found;
  }
  return undefined;
}

/**
 * Resolve `command` to a concrete, spawn-safe executable. Never returns a
 * `shell: true` instruction — the `.cmd`/`.bat` branch is the ONLY place a
 * second process (`cmd.exe`) is introduced, and only with an explicit,
 * validated argv.
 */
export function resolveExecutable(
  command: string,
  args: string[],
  cwd: string,
  deps: ResolveExecutableDeps = {},
): ResolvedExecutable {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const exists = deps.exists ?? existsSync;
  const isWin = platform === 'win32';
  // Select path semantics by the (possibly injected) platform, not by the
  // actual OS running this code — the same way `process.platform === 'win32'`
  // picks `path.win32` by default on a real Windows machine. This is what
  // makes the Windows branch testable from any OS.
  const pathApi = isWin ? win32Path : posixPath;

  let candidate: string | undefined;

  if (command.includes('/') || command.includes('\\')) {
    // 1. Path-like command → resolve against cwd (or use as-is if absolute).
    const resolved = pathApi.isAbsolute(command) ? command : pathApi.join(cwd, command);
    candidate = findExecutable(resolved, isWin, env, exists) ?? resolved;
  } else {
    // 2. node_modules/.bin/<command>
    candidate = findExecutable(
      pathApi.join(cwd, 'node_modules', '.bin', command),
      isWin,
      env,
      exists,
    );
    // 3. PATH
    if (!candidate) candidate = findOnPath(command, isWin, env, exists, pathApi);
  }

  // 4. Fallback: the bare command — `spawn` will surface a clear ENOENT.
  const resolvedFile = candidate ?? command;

  const lower = resolvedFile.toLowerCase();
  const isCmdOrBat = isWin && (lower.endsWith('.cmd') || lower.endsWith('.bat'));

  if (isCmdOrBat) {
    // N8: the allowlist must ALSO cover `resolvedFile` itself — it becomes a
    // token in the `cmd.exe /d /s /c <resolvedFile> ...args` argv just like
    // any other arg, and a path built from an attacker-influenced `cwd`
    // could otherwise smuggle a cmd.exe metacharacter (`&`, `|`, `%`, …)
    // past the allowlist that only checked `args`.
    for (const arg of [resolvedFile, ...args]) {
      if (!WINDOWS_ARG_ALLOWLIST.test(arg)) throw new UnsafeArgError(arg);
    }
    const comSpec = env.ComSpec ?? 'cmd.exe';
    // Quoting (N8, owner decision): we do NOT set `windowsVerbatimArguments`
    // (Node's default per-argv quoting stays on). That default quoting is
    // safe here specifically BECAUSE the allowlist above excludes `"` —
    // every token in this argv is either quote-free (no special handling
    // needed) or contains only an allowlisted space (Node wraps it in `"…"`,
    // and since `"` itself can never appear inside an allowlisted token,
    // there is no way to escape that quoting early). Hand-rolling the
    // command line for `windowsVerbatimArguments: true` would need to
    // reimplement that same escaping with no safety benefit, so we don't.
    return { file: comSpec, args: ['/d', '/s', '/c', resolvedFile, ...args], viaComSpec: true };
  }

  return { file: resolvedFile, args, viaComSpec: false };
}
