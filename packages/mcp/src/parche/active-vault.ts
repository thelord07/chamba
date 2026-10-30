/**
 * parche/active-vault.ts — resolves the active parche vault for auto-sync.
 *
 * PARCHE-011: D3 full precedence order:
 *   1. workspace parche.json     → AUTHORITATIVE, no fallthrough (O2)
 *   2. CHAMBA_OBSIDIAN_VAULT_PATH env (discovery)
 *   3. global ~/.chamba/parche.json → AUTHORITATIVE, no fallthrough
 *   4. Obsidian auto-detection (PARCHE-009 behaviour)
 *
 * When a workspace binding exists but cannot be resolved (missing cred, dir,
 * or realpath mismatch), returns a discriminated `bound-unsyncable` result
 * so callers can distinguish "has binding but can't sync" from "no binding".
 */

import type { ParcheBinding } from '@chamba/core';
import {
  AdoptionPendingError,
  CredentialsStore,
  findWorkspaceRoot,
  joinFirstHint,
  linkDirPlaceholderHint,
  linkHint,
  ObsidianDetector,
  parcheFilePath,
  readParcheBinding,
  readState,
  resolveVaultDir,
  VAULT_CLI,
  VaultDirMissingError,
} from '@chamba/core';
import type { Services } from '../services.js';
import { obsidianSearchRoots } from '../services.js';

// ─── ActiveParcheVault ────────────────────────────────────────────────────────

export interface ActiveParcheVault {
  vaultDir: string;
  server: string;
  slug: string;
  token: string;
  localAuthor: string;
  device: string;
  lastSyncAt?: string;
  /** PARCHE-011: autosync config from the binding (or defaults for env/detection). */
  autoSync: { enabled: boolean; pullTtlMin: number };
}

// ─── Discriminated result type ────────────────────────────────────────────────

export type ActiveParcheVaultResult =
  | { kind: 'ok'; vault: ActiveParcheVault }
  | {
      kind: 'bound-unsyncable';
      vaultDir: string;
      dirExists: boolean;
      reason:
        | 'no-cred'
        | 'dir-missing'
        | 'pending-adoption'
        | 'realpath-mismatch'
        | 'invalid-binding'
        | 'error';
      hint: string;
      /** Present for credential/dir/adoption/realpath cases; absent for invalid-binding/error. */
      binding?: ParcheBinding;
    }
  | { kind: 'none' };

/**
 * Full discriminated resolution. Used by vault_status, doctor wiring, and
 * tools that need to distinguish "bound but unsyncable" from "no binding".
 */
export async function resolveActiveParcheVaultFull(
  services: Services,
): Promise<ActiveParcheVaultResult> {
  // Track workspace root outside try so the catch can use it
  let wsRoot: string | null = null;

  try {
    // ── Step 1: workspace parche.json ──────────────────────────────────────────
    wsRoot =
      services.workspaceRoot ??
      (await findWorkspaceRoot(services.fs, services.cwd, services.homedir));

    if (wsRoot) {
      const wsPath = parcheFilePath(wsRoot);
      const wsResult = await readParcheBinding(services.fs, wsPath, {
        scope: 'workspace',
        baseDir: wsRoot,
      });

      if (wsResult.ok) {
        // AUTHORITATIVE: try to resolve; if not resolvable, return bound-unsyncable (no fallthrough)
        return await resolveFromBinding(wsResult.binding, services);
      }
      // File exists but is invalid → bound-unsyncable, never fall through (O2)
      if (!wsResult.missing) {
        return {
          kind: 'bound-unsyncable',
          reason: 'invalid-binding',
          vaultDir: '',
          dirExists: false,
          hint: `parche.json inválido en ${wsPath}: ${wsResult.error} — corrígelo o usa \`${VAULT_CLI} unlink --scope workspace\``,
        };
      }
    }

    // ── Step 2: CHAMBA_OBSIDIAN_VAULT_PATH env ────────────────────────────────
    if (services.obsidianVaultPath) {
      const envResult = await resolveFromDetection(
        services,
        services.obsidianVaultPath,
        services.parchePullTtlMin,
      );
      if (envResult) return { kind: 'ok', vault: envResult };
    }

    // ── Step 3: global ~/.chamba/parche.json ──────────────────────────────────
    const globalPath = parcheFilePath(services.homedir);
    const globalResult = await readParcheBinding(services.fs, globalPath, {
      scope: 'global',
      baseDir: services.homedir,
    });

    if (globalResult.ok) {
      // AUTHORITATIVE: try to resolve; if not resolvable, return bound-unsyncable (no fallthrough)
      return await resolveFromBinding(globalResult.binding, services);
    }
    // File exists but invalid → bound-unsyncable, never fall through (O2)
    if (!globalResult.missing) {
      return {
        kind: 'bound-unsyncable',
        reason: 'invalid-binding',
        vaultDir: '',
        dirExists: false,
        hint: `parche.json inválido en ${globalPath}: ${globalResult.error} — corrígelo o usa \`${VAULT_CLI} unlink --scope global\``,
      };
    }

    // ── Step 4: auto-detection (PARCHE-009 behavior) ──────────────────────────
    const detected = await resolveViaDetection(services);
    if (detected) return { kind: 'ok', vault: detected };

    return { kind: 'none' };
  } catch (err) {
    if (err instanceof VaultDirMissingError || err instanceof AdoptionPendingError) {
      return { kind: 'none' };
    }
    // If we had found a workspace root, the error likely comes from reading the binding
    if (wsRoot) {
      return {
        kind: 'bound-unsyncable',
        reason: 'error',
        vaultDir: '',
        dirExists: false,
        hint: 'Error al leer el vínculo del workspace — revisa .chamba/parche.json',
      };
    }
    return { kind: 'none' };
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function resolveFromBinding(
  binding: ParcheBinding,
  services: Services,
): Promise<ActiveParcheVaultResult> {
  const creds = new CredentialsStore(services.fs, services.homedir);
  const cred = await creds.get(binding.server, binding.slug);

  if (!cred) {
    // Bug 2: check dirExists against binding.vaultDir (declared dir), not hardcoded false
    const bindingDirExists = await services.fs.exists(binding.vaultDir);
    return {
      kind: 'bound-unsyncable',
      vaultDir: binding.vaultDir,
      dirExists: bindingDirExists,
      reason: 'no-cred',
      hint: `sin credencial — ${joinFirstHint()} --scope ${binding.scope}`,
      binding,
    };
  }

  const credVaultDir = resolveVaultDir(cred, services.homedir, binding.slug);

  // Check dir existence (use credVaultDir — the one we can actually sync to)
  const dirExists = await services.fs.exists(credVaultDir);
  if (!dirExists) {
    return {
      kind: 'bound-unsyncable',
      vaultDir: credVaultDir,
      dirExists: false,
      reason: 'dir-missing',
      hint: `carpeta no existe — ${linkDirPlaceholderHint(binding.slug)}`,
      binding,
    };
  }

  // Check pending adoption
  let state: Awaited<ReturnType<typeof readState>>;
  try {
    state = await readState(services.fs, credVaultDir);
  } catch {
    state = null;
  }

  if (state?.pendingAdoption === true) {
    return {
      kind: 'bound-unsyncable',
      vaultDir: credVaultDir,
      dirExists: true,
      reason: 'pending-adoption',
      hint: `pendiente de confirmar subida — ${linkHint(binding.slug, credVaultDir, { yes: true })}`,
      binding,
    };
  }

  // Realpath guard: binding.vaultDir must match credVaultDir
  const bindingReal = await tryRealpath(services.fs, binding.vaultDir);
  const credReal = await tryRealpath(services.fs, credVaultDir);
  if (bindingReal && credReal && bindingReal !== credReal) {
    // Bug 3: use binding.vaultDir (workspace-declared) not credVaultDir for the returned vaultDir
    const bindingDirExists = await services.fs.exists(binding.vaultDir);
    return {
      kind: 'bound-unsyncable',
      vaultDir: binding.vaultDir,
      dirExists: bindingDirExists,
      reason: 'realpath-mismatch',
      hint: `credencial y parche.json apuntan a carpetas distintas — ${linkHint(binding.slug, binding.vaultDir)}`,
      binding,
    };
  }

  return {
    kind: 'ok',
    vault: {
      vaultDir: credVaultDir,
      server: binding.server,
      slug: binding.slug,
      token: cred.token,
      localAuthor: cred.user.name,
      device: cred.device.label,
      lastSyncAt: state?.lastSyncAt,
      autoSync: binding.autoSync,
    },
  };
}

async function tryRealpath(fs: Services['fs'], path: string): Promise<string | null> {
  try {
    return await fs.realpath(path);
  } catch {
    return null;
  }
}

async function resolveFromDetection(
  services: Services,
  explicitPath: string,
  pullTtlMin: number,
): Promise<ActiveParcheVault | null> {
  try {
    const detection = await new ObsidianDetector(services.fs).detect({
      explicitPath,
      searchRoots: [],
    });
    if (!detection.found || !detection.path) return null;

    const state = await readState(services.fs, detection.path);
    if (!state) return null;
    if (state.pendingAdoption === true) return null;

    const creds = new CredentialsStore(services.fs, services.homedir);
    const cred = await creds.get(state.server, state.slug);
    if (!cred) return null;

    const credVaultDir = resolveVaultDir(cred, services.homedir, state.slug);
    const dirExists = await services.fs.exists(credVaultDir);
    if (!dirExists) return null;

    const a = await tryRealpath(services.fs, detection.path);
    const b = await tryRealpath(services.fs, credVaultDir);
    if (a !== b) return null;

    return {
      vaultDir: credVaultDir,
      server: state.server,
      slug: state.slug,
      token: cred.token,
      localAuthor: cred.user.name,
      device: cred.device.label,
      lastSyncAt: state.lastSyncAt,
      autoSync: { enabled: true, pullTtlMin },
    };
  } catch {
    return null;
  }
}

async function resolveViaDetection(services: Services): Promise<ActiveParcheVault | null> {
  try {
    const detection = await new ObsidianDetector(services.fs).detect({
      explicitPath: services.obsidianVaultPath,
      searchRoots: obsidianSearchRoots(services),
    });
    if (!detection.found || !detection.path) return null;

    const state = await readState(services.fs, detection.path);
    if (!state) return null;
    if (state.pendingAdoption === true) return null;

    const creds = new CredentialsStore(services.fs, services.homedir);
    const cred = await creds.get(state.server, state.slug);
    if (!cred) return null;

    const credVaultDir = resolveVaultDir(cred, services.homedir, state.slug);
    const dirExists = await services.fs.exists(credVaultDir);
    if (!dirExists) return null;

    const a = await tryRealpath(services.fs, detection.path);
    const b = await tryRealpath(services.fs, credVaultDir);
    if (a !== b) return null;

    return {
      vaultDir: credVaultDir,
      server: state.server,
      slug: state.slug,
      token: cred.token,
      localAuthor: cred.user.name,
      device: cred.device.label,
      lastSyncAt: state.lastSyncAt,
      autoSync: { enabled: true, pullTtlMin: services.parchePullTtlMin },
    };
  } catch (err) {
    if (err instanceof VaultDirMissingError || err instanceof AdoptionPendingError) return null;
    return null;
  }
}
