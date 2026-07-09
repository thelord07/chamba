/** A point-in-time snapshot of the machine's compute/memory resources. */
export interface SystemResources {
  /** Total physical memory, in bytes. */
  totalMemBytes: number;
  /** Free physical memory right now, in bytes. */
  freeMemBytes: number;
  /** Logical CPU cores available to this process. */
  cpus: number;
  /** 1-minute load average, or 0 on platforms that don't report it (Windows). */
  loadAvg1: number;
}

/**
 * Read machine resources behind a port so `@chamba/core` never imports `node:os`.
 * Used to size safe parallelism for multi-repo fan-out (no LLM — just numbers).
 */
export interface SystemPort {
  resources(): SystemResources;
}
