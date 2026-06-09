import type { DirEntry, FilesystemPort } from '../ports/filesystem.js';

/**
 * In-memory `FilesystemPort` for tests (CLAUDE.md: tests de IO usan FilesystemPort
 * en memoria). Paths are posix-style. Construct with a map of `path -> contents`.
 */
export class MemoryFilesystem implements FilesystemPort {
  private readonly files = new Map<string, string>();
  private readonly dirs = new Set<string>();

  constructor(initial: Record<string, string> = {}) {
    for (const [path, content] of Object.entries(initial)) {
      this.set(path, content);
    }
  }

  private norm(path: string): string {
    const n = path.replace(/\/+$/, '');
    return n.length === 0 ? '/' : n;
  }

  private set(path: string, content: string): void {
    const norm = this.norm(path);
    this.files.set(norm, content);
    let dir = norm;
    while (dir.includes('/')) {
      const idx = dir.lastIndexOf('/');
      dir = idx === 0 ? '/' : dir.slice(0, idx);
      this.dirs.add(dir);
      if (dir === '/') break;
    }
  }

  async readFile(path: string): Promise<string> {
    const content = this.files.get(this.norm(path));
    if (content === undefined) throw new Error(`ENOENT: no such file '${path}'`);
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.set(path, content);
  }

  async exists(path: string): Promise<boolean> {
    const norm = this.norm(path);
    return this.files.has(norm) || this.dirs.has(norm);
  }

  async mkdir(path: string): Promise<void> {
    this.dirs.add(this.norm(path));
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
    for (const dir of this.dirs) pushChild(dir, true);
    return entries;
  }
}
