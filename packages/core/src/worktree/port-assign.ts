import type { WorktreePortsConfig } from '../config/worktrees.js';
import type { FilesystemPort } from '../ports/filesystem.js';
import type { NetPort } from '../ports/net.js';
import { joinPath } from '../util/path.js';
import { readEnvVar, upsertEnvVar } from './env-upsert.js';

const MAX_ATTEMPTS = 50;

export interface AllocatedPort {
  path: string;
  port: number;
  envKey: string;
  envFile: string;
  /** True when we reused a PORT already in `.env.local` that was still free. */
  reused: boolean;
}

/**
 * Pick a free localhost port starting at `start`, stepping by `step`.
 * Never kills a process — skips occupied ports. Returns null if none found.
 */
export async function allocatePort(
  net: NetPort,
  start: number,
  step: number,
  maxAttempts = MAX_ATTEMPTS,
): Promise<number | null> {
  let port = start;
  for (let i = 0; i < maxAttempts; i++) {
    if (port < 1 || port > 65535) return null;
    if (!(await net.isPortInUse(port))) return port;
    port += step;
  }
  return null;
}

export interface AssignPortsInput {
  net: NetPort;
  fs: FilesystemPort;
  /** Worktree directories, in assignment order. */
  worktreePaths: string[];
  ports: WorktreePortsConfig;
}

/**
 * Write `<envKey>=<port>` into each worktree's `.env.local`. Idempotent: keeps
 * an existing value when that port is still free. Does not copy node_modules.
 */
export async function assignWorktreePorts(input: AssignPortsInput): Promise<AllocatedPort[]> {
  const { net, fs, worktreePaths, ports } = input;
  const results: AllocatedPort[] = [];
  const taken = new Set<number>();

  for (let i = 0; i < worktreePaths.length; i++) {
    const path = worktreePaths[i];
    if (!path) continue;
    const envFile = joinPath(path, '.env.local');
    let existing: string | undefined;
    try {
      existing = await fs.readFile(envFile);
    } catch {
      existing = undefined;
    }
    const current = existing ? readEnvVar(existing, ports.envKey) : undefined;
    const currentPort = current ? Number(current) : Number.NaN;
    let port: number | null = null;
    let reused = false;
    if (Number.isInteger(currentPort) && currentPort > 0 && !taken.has(currentPort)) {
      if (!(await net.isPortInUse(currentPort))) {
        port = currentPort;
        reused = true;
      }
    }
    if (port == null) {
      const start = ports.base + i * ports.step;
      port = await allocatePort(net, start, ports.step);
      while (port != null && taken.has(port)) {
        port = await allocatePort(net, port + ports.step, ports.step);
      }
    }
    if (port == null) continue;
    taken.add(port);
    const next = upsertEnvVar(existing ?? '', ports.envKey, String(port));
    await fs.mkdir(path);
    await fs.writeFile(envFile, next);
    results.push({ path, port, envKey: ports.envKey, envFile, reused });
  }
  return results;
}
