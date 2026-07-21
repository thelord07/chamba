import { homedir } from 'node:os';
import { NodeFilesystem, NodeProcess, NodeSystem, SystemClock } from '@chamba/adapters';
import type { ClockPort, FilesystemPort, ProcessPort, SystemPort } from '@chamba/core';

/**
 * The OS-level services every tool needs, wired to Node adapters by default.
 * Tests inject a `MemoryFilesystem`, a fixed `cwd`/`homedir` and an explicit
 * vault path so tools run without touching the real disk.
 */
export interface Services {
  fs: FilesystemPort;
  process: ProcessPort;
  clock: ClockPort;
  /** Reads live machine resources (RAM/CPU) for safe-parallelism sizing. */
  system: SystemPort;
  /** Workspace root used when a tool doesn't receive an explicit one. */
  cwd: string;
  /** User home directory, used to probe common Obsidian vault locations. */
  homedir: string;
  /** Explicit Obsidian vault path (CHAMBA_OBSIDIAN_VAULT_PATH), if set. */
  obsidianVaultPath?: string;
}

export function createNodeServices(): Services {
  return {
    fs: new NodeFilesystem(),
    process: new NodeProcess(),
    clock: new SystemClock(),
    system: new NodeSystem(),
    cwd: process.cwd(),
    homedir: homedir(),
    obsidianVaultPath: process.env.CHAMBA_OBSIDIAN_VAULT_PATH,
  };
}

/**
 * Common directories to probe for an Obsidian vault, derived from home + cwd. A real
 * personal vault (Documents/Notes/Obsidian) wins over chamba's own global fallback at
 * `~/.chamba/vault`, which is where `workspace_init` bootstraps one (outside any repo).
 */
export function obsidianSearchRoots(services: Services): string[] {
  const { homedir: home, cwd } = services;
  return [
    cwd,
    `${home}/Documents`,
    `${home}/Notes`,
    `${home}/Obsidian`,
    `${home}/obsidian`,
    `${home}/.chamba/vault`,
    home,
  ];
}
