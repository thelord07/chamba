import { NodeFilesystem, NodeProcess, SystemClock } from '@chamba/adapters';
import type { ClockPort, FilesystemPort, ProcessPort } from '@chamba/core';

/**
 * The OS-level services every tool needs, wired to Node adapters by default.
 * Tests inject a `MemoryFilesystem` and a fixed `cwd` so tools run without
 * touching the real disk.
 */
export interface Services {
  fs: FilesystemPort;
  process: ProcessPort;
  clock: ClockPort;
  /** Workspace root used when a tool doesn't receive an explicit one. */
  cwd: string;
}

export function createNodeServices(): Services {
  return {
    fs: new NodeFilesystem(),
    process: new NodeProcess(),
    clock: new SystemClock(),
    cwd: process.cwd(),
  };
}
