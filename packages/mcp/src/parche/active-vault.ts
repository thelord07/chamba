/**
 * parche/active-vault.ts — detects whether the active Obsidian vault is a
 * parche vault (has .chamba-sync/state.json and a credential) and returns the
 * data needed to sync.
 */

import { CredentialsStore, ObsidianDetector, readState } from '@chamba/core';
import { obsidianSearchRoots, type Services } from '../services.js';

export interface ActiveParcheVault {
  vaultDir: string;
  server: string;
  slug: string;
  token: string;
  localAuthor: string;
  device: string;
  lastSyncAt?: string;
}

/**
 * Resolve the active parche vault from `services`.
 *
 * A vault is "active + parche" if:
 *   1. An Obsidian vault is detected (via CHAMBA_OBSIDIAN_VAULT_PATH or detection).
 *   2. `<vault>/.chamba-sync/state.json` exists and parses successfully.
 *   3. `~/.chamba/credentials.json` has a credential for `{server, slug}`.
 *
 * Returns `null` if any condition is not met (no parche vault, no cred, etc.).
 * Never throws — callers use it in a best-effort context.
 */
export async function resolveActiveParcheVault(
  services: Services,
): Promise<ActiveParcheVault | null> {
  try {
    const detection = await new ObsidianDetector(services.fs).detect({
      explicitPath: services.obsidianVaultPath,
      searchRoots: obsidianSearchRoots(services),
    });
    if (!detection.found || !detection.path) return null;

    const vaultDir = detection.path;
    const state = await readState(services.fs, vaultDir);
    if (!state) return null;

    const creds = new CredentialsStore(services.fs, services.homedir);
    const cred = await creds.get(state.server, state.slug);
    if (!cred) return null;

    return {
      vaultDir,
      server: state.server,
      slug: state.slug,
      token: cred.token,
      localAuthor: cred.user.name,
      device: cred.device.label,
      lastSyncAt: state.lastSyncAt,
    };
  } catch {
    return null;
  }
}
