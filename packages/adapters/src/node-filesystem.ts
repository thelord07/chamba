import { execFile as execFileCb } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname as pathDirname, parse as pathParse } from 'node:path';
import { promisify } from 'node:util';
import type { DirEntry, FileStat, FilesystemPort, WriteBytesOptions } from '@chamba/core';

const execFileAsync = promisify(execFileCb);

/** Injectable exec function type for testing (mirrors `util.promisify(execFile)`). */
export type ExecFileFn = (
  cmd: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

/** Options for `NodeFilesystem` — all optional, injectable for testing. */
export interface NodeFilesystemOptions {
  /**
   * OS platform string. Defaults to `process.platform`. Pass `'win32'` in
   * non-Windows tests to exercise the Windows ACL code path.
   */
  platform?: string;
  /**
   * Username for icacls (Windows ACL). Defaults to `os.userInfo().username`.
   * Inject in tests to avoid reading the real OS user.
   */
  username?: string;
  /**
   * Exec function for `secureFile`. Defaults to `util.promisify(execFile)`.
   * Inject a mock in tests to assert icacls is called with the right args.
   */
  execFn?: ExecFileFn;
}

/** Node-backed `FilesystemPort`. */
export class NodeFilesystem implements FilesystemPort {
  private readonly _platform: string;
  private readonly _username: string | undefined;
  private readonly _execFn: ExecFileFn;

  constructor(opts: NodeFilesystemOptions = {}) {
    this._platform = opts.platform ?? process.platform;
    this._username = opts.username;
    this._execFn = opts.execFn ?? execFileAsync;
  }
  async readFile(path: string): Promise<string> {
    return readFile(path, 'utf8');
  }

  async writeFile(path: string, content: string): Promise<void> {
    await writeFile(path, content, 'utf8');
  }

  async readDir(path: string): Promise<DirEntry[]> {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e) => ({
      name: e.name,
      isDirectory: e.isDirectory(),
      isFile: e.isFile(),
    }));
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  }

  async remove(path: string): Promise<void> {
    await rm(path, { recursive: true, force: true });
  }

  // ── PARCHE-004 extensions ──────────────────────────────────────────────────

  async readBytes(path: string): Promise<Uint8Array> {
    const buf = await readFile(path);
    return new Uint8Array(buf);
  }

  /**
   * Write bytes atomically: write to a tmp file in the same directory, then
   * rename over the destination. If `opts.mode` is set, apply `chmod` after
   * the rename so there is no window where the file has broad permissions.
   *
   * Throws a clear error if the rename would cross filesystems (EXDEV).
   */
  async writeBytes(path: string, data: Uint8Array, opts?: WriteBytesOptions): Promise<void> {
    // Derive tmp path in the same directory to guarantee atomic rename.
    // Use node:path so this works on Windows with drive letters and backslashes.
    const parsed = pathParse(path);
    const dir = parsed.dir || '.';
    const base = parsed.base;
    const rand = randomBytes(4).toString('hex');
    const pid = process.pid;
    const sep = dir === '.' ? '' : dir.endsWith('\\') || dir.endsWith('/') ? '' : '/';
    const tmp = `${dir}${sep}.${base}.${pid}-${rand}.tmp`;

    try {
      if (dir && dir !== '.') {
        await mkdir(dir, { recursive: true });
      }
      await writeFile(tmp, data, opts?.mode !== undefined ? { mode: opts.mode } : undefined);
      await rename(tmp, path);
      if (opts?.mode !== undefined) {
        // Re-apply mode after rename because umask may have narrowed it
        await chmod(path, opts.mode);
      }
    } catch (err) {
      // Clean up tmp on failure
      await rm(tmp, { force: true });
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'EXDEV'
      ) {
        throw new Error(
          `writeBytes: cannot rename across filesystems (EXDEV). ` +
            `Ensure the vault and its .chamba-sync directory are on the same volume. ` +
            `tmp="${tmp}" dst="${path}"`,
        );
      }
      throw err;
    }
  }

  async rename(from: string, to: string): Promise<void> {
    try {
      await rename(from, to);
    } catch (err) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'EXDEV'
      ) {
        throw new Error(
          `rename: cannot move across filesystems (EXDEV). from="${from}" to="${to}"`,
        );
      }
      throw err;
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const s = await stat(path);
      return { size: s.size, mtimeMs: s.mtimeMs };
    } catch (err) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return null;
      }
      throw err;
    }
  }

  /**
   * Resolve symlinks to a canonical path. ENOENT-tolerant: walks up to the
   * nearest existing ancestor and re-appends the remaining path segments.
   *
   * Uses `node:path` so it handles Windows drive letters and UNC paths
   * correctly (e.g. `C:\foo\bar` that doesn't exist yet).
   */
  async realpath(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch (err) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        // Walk up to the nearest existing ancestor using node:path.dirname
        // so we handle Windows drive roots (C:\) and UNC paths (\\srv\share)
        // correctly without hardcoding the root as '/'.
        let candidate = path;
        const tail: string[] = [];

        for (let i = 0; i < 256; i++) {
          const parent = pathDirname(candidate);
          if (parent === candidate) {
            // Reached the root — resolve it (it must exist)
            try {
              const resolvedRoot = await realpath(candidate);
              return tail.length === 0 ? resolvedRoot : `${resolvedRoot}/${tail.join('/')}`;
            } catch {
              // Root itself not resolvable — return path as-is
              return path;
            }
          }
          tail.unshift(pathParse(candidate).base);
          candidate = parent;
          try {
            const resolvedAncestor = await realpath(candidate);
            return tail.length === 0 ? resolvedAncestor : `${resolvedAncestor}/${tail.join('/')}`;
          } catch (innerErr) {
            if (
              innerErr instanceof Error &&
              'code' in innerErr &&
              (innerErr as NodeJS.ErrnoException).code === 'ENOENT'
            ) {
              continue;
            }
            throw innerErr;
          }
        }
        // Fallback: return path as-is
        return path;
      }
      throw err;
    }
  }

  /**
   * Harden file permissions so only the current OS user can read/write `path`.
   *
   * On Windows: runs `icacls <path> /inheritance:r /grant:r <user>:(F)` without a
   * shell (no `%USERNAME%` expansion — the username is read via `os.userInfo()`).
   * On POSIX: no-op (`writeBytes` already applies mode 0600).
   *
   * Never throws — returns `{ ok: false, warning }` on failure so the caller can
   * surface a user-facing message without aborting the credential write.
   */
  async secureFile(path: string): Promise<{ ok: boolean; warning?: string }> {
    if (this._platform !== 'win32') {
      return { ok: true };
    }
    try {
      const username =
        this._username ??
        (() => {
          try {
            return userInfo().username;
          } catch {
            return undefined;
          }
        })();

      if (!username) {
        return {
          ok: false,
          warning:
            `No se pudo obtener el nombre de usuario del sistema para proteger ${path}. ` +
            `Verifica manualmente con: icacls "${path}"`,
        };
      }

      await this._execFn('icacls', [path, '/inheritance:r', '/grant:r', `${username}:(F)`]);
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        warning:
          `No se pudo proteger ${path} con icacls: ${msg}. ` +
          `El archivo se escribió correctamente pero puede ser legible por otros usuarios. ` +
          `Verifica el ACL manualmente o confía en el ACL del perfil de usuario.`,
      };
    }
  }
}
