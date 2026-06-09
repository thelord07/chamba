/** A single entry returned when listing a directory. */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
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
}
