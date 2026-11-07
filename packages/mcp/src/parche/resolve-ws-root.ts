/**
 * parche/resolve-ws-root.ts — CHAMBA-020
 *
 * Shared helper to resolve the workspace root consistently across the tool
 * (chamba_task_metrics) and the CLI (`npx @chamba/mcp metrics`).
 *
 * Resolution order:
 *   1. `services.workspaceRoot` — explicitly configured workspace root
 *   2. `findWorkspaceRoot(...)` — walk up from cwd looking for workspace marker
 *   3. `services.cwd` — final fallback
 */

import { findWorkspaceRoot } from '@chamba/core';
import type { Services } from '../services.js';

/**
 * Resolve the workspace root from services.
 * Tool and CLI both call this so the resolution is always identical.
 */
export async function resolveWsRoot(services: Services): Promise<string> {
  if (services.workspaceRoot) return services.workspaceRoot;
  const found = await findWorkspaceRoot(
    services.fs,
    services.cwd,
    services.homedir,
    services.platform,
  );
  return found ?? services.cwd;
}
