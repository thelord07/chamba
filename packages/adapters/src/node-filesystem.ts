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
import type { DirEntry, FileStat, FilesystemPort, WriteBytesOptions } from '@chamba/core';

/** Node-backed `FilesystemPort`. */
export class NodeFilesystem implements FilesystemPort {
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
    // Derive tmp path in the same directory to guarantee atomic rename
    const lastSlash = path.lastIndexOf('/');
    const dir = lastSlash >= 0 ? path.slice(0, lastSlash) : '.';
    const basename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
    const rand = randomBytes(4).toString('hex');
    const pid = process.pid;
    const tmp = `${dir ? `${dir}/` : ''}.${basename}.${pid}-${rand}.tmp`;

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
        // Find the nearest ancestor that exists
        const sep = '/';
        const parts = path.split(sep).filter(Boolean);
        let candidate = sep;
        let resolved = sep;
        for (let i = 0; i < parts.length; i++) {
          const next = candidate === sep ? `/${parts[i]}` : `${candidate}/${parts[i]}`;
          try {
            resolved = await realpath(next);
            candidate = next;
          } catch {
            // This segment doesn't exist — append remaining parts lexically
            const remaining = parts.slice(i).join(sep);
            return `${resolved === sep ? '' : resolved}/${remaining}`;
          }
        }
        return resolved;
      }
      throw err;
    }
  }
}
