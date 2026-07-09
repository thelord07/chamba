import { availableParallelism, cpus, freemem, loadavg, totalmem } from 'node:os';
import type { SystemPort, SystemResources } from '@chamba/core';

/** Node-backed `SystemPort` reading live machine resources via `node:os`. */
export class NodeSystem implements SystemPort {
  resources(): SystemResources {
    return {
      totalMemBytes: totalmem(),
      freeMemBytes: freemem(),
      // availableParallelism (Node 19+) is container/affinity-aware; fall back
      // to the raw logical core count if it's ever unavailable.
      cpus: safeParallelism(),
      // loadavg() returns [0, 0, 0] on Windows — treated as "no load" upstream.
      loadAvg1: loadavg()[0] ?? 0,
    };
  }
}

function safeParallelism(): number {
  try {
    return availableParallelism();
  } catch {
    return cpus().length || 1;
  }
}
