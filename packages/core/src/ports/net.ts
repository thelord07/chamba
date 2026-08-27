/**
 * Local TCP probes behind a port so `@chamba/core` never imports `node:net`.
 * Used to allocate a free PORT per worktree without killing anything.
 */
export interface NetPort {
  /** True when something is already listening on localhost:port. */
  isPortInUse(port: number): Promise<boolean>;
}
