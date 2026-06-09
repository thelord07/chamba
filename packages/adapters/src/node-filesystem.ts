import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import type { DirEntry, FilesystemPort } from '@chamba/core';

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
}
