import { homedir } from 'node:os';
import {
  NodeFilesystem,
  NodeHash,
  NodeHttp,
  NodeNet,
  NodeProcess,
  NodeSystem,
  SystemClock,
} from '@chamba/adapters';
import type {
  ClockPort,
  FilesystemPort,
  HashPort,
  HttpPort,
  NetPort,
  ProcessPort,
  SystemPort,
} from '@chamba/core';

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
  /** Optional TCP probe for per-worktree PORT assignment. */
  net?: NetPort;
  /** HTTP client for parche API calls. */
  http: HttpPort;
  /** SHA-256 hash port for sync operations. */
  hash: HashPort;
  /** Workspace root used when a tool doesn't receive an explicit one. */
  cwd: string;
  /** User home directory, used to probe common Obsidian vault locations. */
  homedir: string;
  /** Explicit Obsidian vault path (CHAMBA_OBSIDIAN_VAULT_PATH), if set. */
  obsidianVaultPath?: string;
  /** Parche server URL (CHAMBA_PARCHE_URL). Falls back to DEFAULT_PARCHE_URL. */
  parcheServerUrl?: string;
  /**
   * Minimum minutes before a pull-on-read is triggered in auto-sync.
   * Configurable via CHAMBA_PARCHE_PULL_TTL_MIN; defaults to 5.
   */
  parchePullTtlMin: number;
  /**
   * Per-vault mutex map. Key is "<server>|<slug>".
   * Guards against two tools syncing the same vault concurrently within one process.
   * Cross-process locking is not implemented (see plan Riesgos).
   */
  vaultMutex: Map<string, Promise<void>>;
  /**
   * Budget in milliseconds for an auto-sync triggered by a tool call.
   * Defaults to `AUTOSYNC_BUDGET_MS` (10 s) in production.
   * Injectable for tests to exercise the timeout path without real waiting.
   */
  autosyncBudgetMs?: number;
}

export function createNodeServices(): Services {
  return {
    fs: new NodeFilesystem(),
    process: new NodeProcess(),
    clock: new SystemClock(),
    system: new NodeSystem(),
    net: new NodeNet(),
    http: new NodeHttp(),
    hash: new NodeHash(),
    cwd: process.cwd(),
    homedir: homedir(),
    obsidianVaultPath: process.env.CHAMBA_OBSIDIAN_VAULT_PATH,
    parcheServerUrl: process.env.CHAMBA_PARCHE_URL,
    parchePullTtlMin: Number(process.env.CHAMBA_PARCHE_PULL_TTL_MIN ?? '5') || 5,
    vaultMutex: new Map(),
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
