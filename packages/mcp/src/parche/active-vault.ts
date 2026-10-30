/**
 * parche/active-vault.ts — detects whether the active Obsidian vault is a
 * parche vault (has .chamba-sync/state.json and a credential) and returns the
 * data needed to sync.
 */

import {
  AdoptionPendingError,
  CredentialsStore,
  ObsidianDetector,
  readState,
  resolveVaultDir,
  VaultDirMissingError,
} from '@chamba/core';
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

    const state = await readState(services.fs, detection.path);
    if (!state) return null;

    // PARCHE-009: block autosync when vault is pending adoption confirmation
    if (state.pendingAdoption === true) return null;

    const creds = new CredentialsStore(services.fs, services.homedir);
    const cred = await creds.get(state.server, state.slug);
    if (!cred) return null;

    // PARCHE-009: use resolveVaultDir as the canonical source of the vault dir,
    // then compare realpaths to guard against stale dirs after vault link.
    const credVaultDir = resolveVaultDir(cred, services.homedir, state.slug);

    // PARCHE-009: block autosync if the vault dir no longer exists
    const dirExists = await services.fs.exists(credVaultDir);
    if (!dirExists) return null;

    // Guard: ensure the detected path resolves to the same canonical path as the credential
    const a = await services.fs.realpath(detection.path);
    const b = await services.fs.realpath(credVaultDir);
    if (a !== b) return null;

    return {
      vaultDir: credVaultDir,
      server: state.server,
      slug: state.slug,
      token: cred.token,
      localAuthor: cred.user.name,
      device: cred.device.label,
      lastSyncAt: state.lastSyncAt,
    };
  } catch (err) {
    // Suppress known PARCHE-009 errors gracefully
    if (err instanceof VaultDirMissingError || err instanceof AdoptionPendingError) return null;
    return null;
  }
}
