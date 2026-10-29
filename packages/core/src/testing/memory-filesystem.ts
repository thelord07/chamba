import type { DirEntry, FileStat, FilesystemPort, WriteBytesOptions } from '../ports/filesystem.js';

/**
 * In-memory `FilesystemPort` for tests (CLAUDE.md: tests de IO usan FilesystemPort
 * en memoria). Paths are posix-style. Construct with a map of `path -> contents`.
 *
 * Extended in PARCHE-004 to support readBytes / writeBytes (atomic, records mode)
 * / rename / stat.
 */
export class MemoryFilesystem implements FilesystemPort {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>();
  /** Raw byte buffers — parallel to `files` for binary paths. */
  private readonly bytes = new Map<string, Uint8Array>();
  /** File mode per path (e.g. 0o600). */
  private readonly modes = new Map<string, number>();
  /** Mtime per path (ms since epoch). */
  private readonly mtimes = new Map<string, number>();

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) {
      this.set(path, content);
    }
  }

  private norm(path: string): string {
    const n = path.replace(/\/+$/, '');
    return n.length === 0 ? '/' : n;
  }

  private ensureDirs(norm: string): void {
    let dir = norm;
    while (dir.includes('/')) {
      const idx = dir.lastIndexOf('/');
      dir = idx === 0 ? '/' : dir.slice(0, idx);
      this.dirs.add(dir);
      if (dir === '/') break;
    }
  }

  private set(path: string, content: string): void {
    const norm = this.norm(path);
    this.files.set(norm, content);
    this.bytes.delete(norm); // text overwrites binary
    this.mtimes.set(norm, Date.now());
    this.ensureDirs(norm);
  }

  async readFile(path: string): Promise<string> {
    const norm = this.norm(path);
    // If only bytes exist, decode as UTF-8
    if (!this.files.has(norm) && this.bytes.has(norm)) {
      const b = this.bytes.get(norm) as Uint8Array;
      return new TextDecoder().decode(b);
    }
    const content = this.files.get(norm);
    if (content === undefined) throw new Error(`ENOENT: no such file '${path}'`);
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.set(path, content);
  }

  async exists(path: string): Promise<boolean> {
    const norm = this.norm(path);
    return this.files.has(norm) || this.bytes.has(norm) || this.dirs.has(norm);
  }

  async mkdir(path: string): Promise<void> {
    const norm = this.norm(path);
    this.dirs.add(norm);
    this.ensureDirs(norm);
  }

  async remove(path: string): Promise<void> {
    const norm = this.norm(path);
    this.files.delete(norm);
    this.bytes.delete(norm);
    this.modes.delete(norm);
    this.mtimes.delete(norm);
    this.dirs.delete(norm);
    const prefix = `${norm}/`;
    for (const file of [...this.files.keys()]) {
      if (file.startsWith(prefix)) {
        this.files.delete(file);
        this.bytes.delete(file);
        this.modes.delete(file);
        this.mtimes.delete(file);
      }
    }
    for (const dir of [...this.dirs]) {
      if (dir.startsWith(prefix)) this.dirs.delete(dir);
    }
  }

  async readDir(path: string): Promise<DirEntry[]> {
    const norm = this.norm(path);
    const prefix = norm === '/' ? '/' : `${norm}/`;
    const seen = new Set<string>();
    const entries: DirEntry[] = [];

    const pushChild = (full: string, isDir: boolean): void => {
      if (!full.startsWith(prefix) || full === norm) return;
      const rest = full.slice(prefix.length);
      const slash = rest.indexOf('/');
      const name = slash === -1 ? rest : rest.slice(0, slash);
      const childIsDir = slash !== -1 || isDir;
      if (name.length === 0 || seen.has(name)) return;
      seen.add(name);
      entries.push({ name, isDirectory: childIsDir, isFile: !childIsDir });
    };

    for (const file of this.files.keys()) pushChild(file, false);
    for (const file of this.bytes.keys()) pushChild(file, false);
    for (const dir of this.dirs) pushChild(dir, true);
    return entries;
  }

  // ── New methods (PARCHE-004) ─────────────────────────────────────────────────

  async readBytes(path: string): Promise<Uint8Array> {
    const norm = this.norm(path);
    const raw = this.bytes.get(norm);
    if (raw !== undefined) return raw;
    // Fall back to text if stored as string
    const text = this.files.get(norm);
    if (text !== undefined) return new TextEncoder().encode(text);
    throw new Error(`ENOENT: no such file '${path}'`);
  }

  async writeBytes(path: string, data: Uint8Array, opts?: WriteBytesOptions): Promise<void> {
    const norm = this.norm(path);
    // Atomic in the in-memory sense: set both maps in one logical step
    this.bytes.set(norm, data);
    this.files.delete(norm); // bytes overwrite text
    this.mtimes.set(norm, Date.now());
    if (opts?.mode !== undefined) {
      this.modes.set(norm, opts.mode);
    }
    this.ensureDirs(norm);
  }

  async rename(from: string, to: string): Promise<void> {
    const src = this.norm(from);
    const dst = this.norm(to);

    const hasText = this.files.has(src);
    const hasRaw = this.bytes.has(src);
    if (!hasText && !hasRaw) {
      throw new Error(`ENOENT: rename '${from}' -> '${to}'`);
    }

    if (hasText) {
      this.files.set(dst, this.files.get(src) as string);
      this.files.delete(src);
    }
    if (hasRaw) {
      this.bytes.set(dst, this.bytes.get(src) as Uint8Array);
      this.bytes.delete(src);
    }
    const mode = this.modes.get(src);
    if (mode !== undefined) {
      this.modes.set(dst, mode);
      this.modes.delete(src);
    }
    const mtime = this.mtimes.get(src);
    this.mtimes.set(dst, mtime ?? Date.now());
    this.mtimes.delete(src);
    this.ensureDirs(dst);
  }

  async stat(path: string): Promise<FileStat | null> {
    const norm = this.norm(path);
    const raw = this.bytes.get(norm);
    if (raw !== undefined) {
      return { size: raw.byteLength, mtimeMs: this.mtimes.get(norm) ?? 0 };
    }
    const text = this.files.get(norm);
    if (text !== undefined) {
      const size = new TextEncoder().encode(text).byteLength;
      return { size, mtimeMs: this.mtimes.get(norm) ?? 0 };
    }
    return null;
  }

  /** Test helper: get the recorded file mode (undefined if not set). */
  getMode(path: string): number | undefined {
    return this.modes.get(this.norm(path));
  }
}
