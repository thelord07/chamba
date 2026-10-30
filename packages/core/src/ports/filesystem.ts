/** A single entry returned when listing a directory. */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

/** File stat information. */
export interface FileStat {
  size: number;
  mtimeMs: number;
}

/** Options for writeBytes. */
export interface WriteBytesOptions {
  /** Unix file mode to apply after writing (e.g. 0o600). */
  mode?: number;
}

/**
 * Filesystem access behind a port so `@chamba/core` never imports `node:fs`.
 * Node implementation lives in `@chamba/adapters`; an in-memory implementation
 * for tests lives in `@chamba/core/testing`.
 */
export interface FilesystemPort {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  readDir(path: string): Promise<DirEntry[]>;
  exists(path: string): Promise<boolean>;
  /** Create a directory and any missing parents (recursive). */
  mkdir(path: string): Promise<void>;
  /** Remove a file or directory (recursive); a no-op if it doesn't exist. */
  remove(path: string): Promise<void>;
  /** Read raw bytes from a file. */
  readBytes(path: string): Promise<Uint8Array>;
  /**
   * Write raw bytes to a file atomically (tmp + rename in the same directory).
   * If `opts.mode` is provided, it is applied to the file after the rename
   * (overriding umask) so there is no window where the file is readable.
   */
  writeBytes(path: string, data: Uint8Array, opts?: WriteBytesOptions): Promise<void>;
  /** Rename (move) a file or directory. Throws on cross-filesystem moves (EXDEV). */
  rename(from: string, to: string): Promise<void>;
  /** Return stat info, or `null` if the path does not exist (ENOENT). */
  stat(path: string): Promise<FileStat | null>;
  /**
   * Resolve symlinks and return the canonical absolute path.
   * Tolerant to ENOENT: if the path does not exist, resolves the nearest
   * existing ancestor and re-appends the remaining segments.
   */
  realpath(path: string): Promise<string>;
}
