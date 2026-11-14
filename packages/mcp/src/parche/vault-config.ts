/**
 * parche/vault-config.ts — CHAMBA-022 (O1 — owner decision).
 *
 * Reads `vault.syncEvidence` from the SAME two config layers
 * `chamba_task verify` reads (B9): `<homedir>/.chamba/config.json` and
 * `<wsRoot>/.chamba/config.json`. Project wins over global; a missing or
 * invalid layer is silently skipped (`parseChambaConfig` never throws).
 * Default (absent in both layers): `false` — evidence images are excluded
 * from sync.
 */

import { joinPath, parseChambaConfig, WORKSPACE_DIR } from '@chamba/core';
import type { Services } from '../services.js';
import { resolveWsRoot } from './resolve-ws-root.js';

const CONFIG_FILE = `${WORKSPACE_DIR}/config.json`;

async function readVaultSyncEvidence(
  services: Services,
  path: string,
): Promise<boolean | undefined> {
  try {
    if (!(await services.fs.exists(path))) return undefined;
    const text = await services.fs.readFile(path);
    const parsed = parseChambaConfig(JSON.parse(text));
    if (!parsed.ok) return undefined;
    return parsed.value.vault?.syncEvidence;
  } catch {
    return undefined;
  }
}

/** Resolve the effective `vault.syncEvidence` flag (project layer wins over global). */
export async function resolveSyncEvidenceFlag(services: Services): Promise<boolean> {
  const wsRoot = await resolveWsRoot(services);
  const globalPath = joinPath(services.homedir, CONFIG_FILE);
  const projectPath = joinPath(wsRoot, CONFIG_FILE);

  const global = await readVaultSyncEvidence(services, globalPath);
  const project = await readVaultSyncEvidence(services, projectPath);
  return project ?? global ?? false;
}
