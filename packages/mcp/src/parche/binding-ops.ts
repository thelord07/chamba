/**
 * parche/binding-ops.ts — shared orchestration logic for vault join/link/unlink/resync.
 *
 * PARCHE-010 O1: central module so that cli/vault.ts and the MCP tools share
 * a single implementation instead of diverging inline copies.
 *
 * All functions use `Services` (injectable) — no Node APIs directly.
 * Presentation (TTY prompts, exit codes, text formatting) stays in each caller.
 */

import type {
  AdoptionSummary,
  CredentialEntry,
  ParcheBinding,
  ParcheScope,
  SyncSummary,
} from '@chamba/core';
import {
  buildAdoptionSummary,
  CredentialsStore,
  clearPendingAdoption,
  expandTilde,
  findWorkspaceRoot,
  joinPath,
  lexicalNormalize,
  ParcheClient,
  parcheFilePath,
  parseJoinInput,
  pendingJoinCodeHashOf,
  prepareVaultDir,
  readParcheBinding,
  readState,
  resetVaultState,
  resolveParcheBinding,
  resolveServerUrl,
  resolveVaultDir,
  syncOnce,
  unlinkWorkspaceHint,
  VaultDirValidationError,
  writeParcheBinding,
  writeState,
} from '@chamba/core';
import type { Services } from '../services.js';
import { withVaultLock } from './mutex.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Redact any `pch_` tokens from a string.
 * PARCHE-010 R1: no `pch_` prefix should ever appear in tool outputs.
 */
export function redactSecrets(text: string): string {
  return text.replace(/pch_[A-Za-z0-9_-]+/g, '<token redactado>');
}

// ─── 1. Scope resolution ──────────────────────────────────────────────────────

export type ScopeResolution =
  | { kind: 'resolved'; scope: ParcheScope; wsRoot: string | null }
  | { kind: 'needs-scope'; wsRoot: string }
  | { kind: 'error'; message: string };

/**
 * Resolve the effective scope for a join operation.
 * - If `scopeFlag` is given and valid → resolved immediately.
 * - If inside a workspace and no flag → needs-scope (the tool must ask).
 * - If not in a workspace and no flag → global.
 * - Invalid flag → error.
 */
export async function resolveJoinScope(
  services: Services,
  scopeFlag?: string,
): Promise<ScopeResolution> {
  const wsRoot =
    services.workspaceRoot ??
    (await findWorkspaceRoot(services.fs, services.cwd, services.homedir));

  if (scopeFlag === 'workspace' || scopeFlag === 'global') {
    const scope = scopeFlag as ParcheScope;
    if (scope === 'workspace' && !wsRoot) {
      return {
        kind: 'error',
        message:
          `--scope workspace requiere estar dentro de un workspace (con .chamba/workspace.md). ` +
          `No se detectó workspace desde ${services.cwd}.`,
      };
    }
    return { kind: 'resolved', scope, wsRoot: wsRoot ?? null };
  }

  if (scopeFlag) {
    return {
      kind: 'error',
      message: `scope debe ser "workspace" o "global" (recibido: "${scopeFlag}")`,
    };
  }

  // No flag given
  if (!wsRoot) {
    return { kind: 'resolved', scope: 'global', wsRoot: null };
  }

  // In a workspace, no scope → must ask
  return { kind: 'needs-scope', wsRoot };
}

// ─── 2. Pre-check workspace binding (join) ────────────────────────────────────

export type Precheck = { kind: 'ok' } | { kind: 'reject'; message: string };

/**
 * Pre-validate an invite code against an existing workspace binding.
 * Uses `ParcheClient.checkInvite` — does NOT consume the invitation.
 */
export async function precheckWorkspaceBinding(
  services: Services,
  opts: { wsRoot: string; codeOrLink: string; serverFlag?: string },
): Promise<Precheck> {
  const { wsRoot, codeOrLink, serverFlag } = opts;
  const existingBindingPath = parcheFilePath(wsRoot);
  const existingBindingResult = await readParcheBinding(services.fs, existingBindingPath, {
    scope: 'workspace',
    baseDir: wsRoot,
  });

  if (!existingBindingResult.ok) return { kind: 'ok' };

  // Try to resolve server from the code/link
  let preServer: string | undefined;
  let preCode = codeOrLink;
  try {
    const preParsed = parseJoinInput(codeOrLink);
    preServer = resolveServerUrl({
      linkServer: preParsed.server,
      envUrl: services.parcheServerUrl,
      flagServer: serverFlag,
    });
    preCode = preParsed.code;
  } catch {
    // Can't resolve server yet → reject conservatively
    return {
      kind: 'reject',
      message:
        `Este workspace ya está vinculado al parche "${existingBindingResult.binding.slug}". ` +
        `Usa \`${unlinkWorkspaceHint()}\` para re-vincular.`,
    };
  }

  const checkResult = await ParcheClient.checkInvite(services.http, preServer, preCode);

  if (checkResult.status === 'invalid') {
    return { kind: 'reject', message: 'código inválido, vencido o agotado' };
  }
  if (checkResult.status === 'not-found') {
    return {
      kind: 'reject',
      message:
        `No se pudo verificar el código — el servidor no reconoce la invitación. ` +
        `Si quieres vincular a otro parche, primero usa \`${unlinkWorkspaceHint()}\`.`,
    };
  }
  if (checkResult.status === 'network-error') {
    return {
      kind: 'reject',
      message: `No pude verificar el código (red/servidor): ${checkResult.message}. Reintenta.`,
    };
  }
  // valid: check slug
  if (checkResult.slug !== existingBindingResult.binding.slug) {
    return {
      kind: 'reject',
      message:
        `Este workspace ya está vinculado al parche "${existingBindingResult.binding.slug}", ` +
        `pero el código es para "${checkResult.slug}". ` +
        `Usa \`${unlinkWorkspaceHint()}\` para desvincular primero.`,
    };
  }
  // Same slug → allow re-join
  return { kind: 'ok' };
}

// ─── 3. Prepare vault dir for join ───────────────────────────────────────────

export type PrepareDir =
  | { kind: 'ok'; canonicalDir?: string; gitignored: string[] }
  | { kind: 'in-repo'; dir: string }
  | { kind: 'error'; message: string };

/**
 * Validate / create the vault directory for a join operation.
 * When `allowInRepo` is false and the dir is inside a git repo, returns `in-repo`.
 */
export async function prepareJoinVaultDir(
  services: Services,
  opts: { dirInput?: string; allowInRepo: boolean; server: string },
): Promise<PrepareDir> {
  const { dirInput, allowInRepo, server } = opts;
  if (!dirInput) return { kind: 'ok', gitignored: [] };

  const creds = new CredentialsStore(services.fs, services.homedir);
  const existingSlugs = await creds.listSlugs();
  const existingLinks: Array<{ server: string; slug: string; dir: string }> = [];
  for (const { server: srv, slug: sl } of existingSlugs) {
    const existingCred = await creds.get(srv, sl);
    if (existingCred) {
      existingLinks.push({
        server: srv,
        slug: sl,
        dir: resolveVaultDir(existingCred, services.homedir, sl),
      });
    }
  }

  try {
    const prepared = await prepareVaultDir(
      { fs: services.fs },
      {
        input: dirInput,
        homedir: services.homedir,
        cwd: services.cwd,
        slug: 'temp',
        server,
        allowInRepo,
        existingLinks,
        platform: process.platform,
      },
    );
    return { kind: 'ok', canonicalDir: prepared.vaultDir, gitignored: prepared.gitignored };
  } catch (err) {
    if (err instanceof VaultDirValidationError) {
      if (err.code === 'in_repo') {
        return { kind: 'in-repo', dir: dirInput };
      }
      return { kind: 'error', message: err.message };
    }
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

// ─── 4. Persist parche.json after join ───────────────────────────────────────

export class BindingWriteError extends Error {
  override name = 'BindingWriteError';
  constructor(
    public bindingPath: string,
    public jsonContent: string,
    cause: unknown,
  ) {
    super(
      `No se pudo escribir ${bindingPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/**
 * Persist parche.json after a successful join (R6/R11: also on needsConfirmation).
 * Idempotent: if the file already has the same content, it is not rewritten.
 * Returns null if no binding root can be determined.
 */
export async function persistBindingAfterJoin(
  services: Services,
  opts: {
    scope: ParcheScope;
    wsRoot: string | null;
    server: string;
    slug: string;
    vaultDir: string;
  },
): Promise<{ bindingPath: string; persistedVaultDir: string } | null> {
  const { scope, wsRoot, server, slug, vaultDir } = opts;
  const bindingRoot = scope === 'workspace' ? wsRoot : services.homedir;
  if (!bindingRoot) return null;

  let persistVaultDir = vaultDir;
  if (scope === 'workspace' && wsRoot && vaultDir.startsWith(`${wsRoot}/`)) {
    persistVaultDir = vaultDir.slice(wsRoot.length + 1);
  }

  const bindingPath = parcheFilePath(bindingRoot);
  const bindingContent = JSON.stringify(
    {
      version: 1,
      server,
      slug,
      vaultDir: persistVaultDir,
      autoSync: { enabled: true, pullTtlMin: 5 },
    },
    null,
    2,
  );

  try {
    await writeParcheBinding(services.fs, bindingPath, {
      version: 1,
      server,
      slug,
      vaultDir: persistVaultDir,
      autoSync: { enabled: true, pullTtlMin: 5 },
    });
    return { bindingPath, persistedVaultDir: persistVaultDir };
  } catch (e) {
    throw new BindingWriteError(bindingPath, bindingContent, e);
  }
}

// ─── 5. Prepare re-link ───────────────────────────────────────────────────────

export type RelinkPrepare =
  | { kind: 'noop'; canonicalDir: string }
  | {
      kind: 'ready';
      server: string;
      cred: CredentialEntry;
      oldDir: string;
      canonicalDir: string;
      summary: AdoptionSummary;
      gitignored: string[];
    }
  | { kind: 'in-repo'; dir: string }
  | { kind: 'error'; message: string };

/**
 * Prepare a vault re-link: validate new dir, update credential, reset state, build summary.
 * Does NOT call syncOnce — caller confirms gate then calls finalizeAdoption.
 */
export async function relinkPrepare(
  services: Services,
  opts: { slug: string; dirInput: string; allowInRepo: boolean },
): Promise<RelinkPrepare> {
  const { slug, dirInput, allowInRepo } = opts;

  const creds = new CredentialsStore(services.fs, services.homedir);
  const allSlugs = await creds.listSlugs();
  const found = allSlugs.find((s) => s.slug === slug);
  if (!found) {
    return { kind: 'error', message: `No se encontró credencial para el vault "${slug}".` };
  }

  const cred = await creds.get(found.server, slug);
  if (!cred) {
    return { kind: 'error', message: `No se encontró credencial para el vault "${slug}".` };
  }

  const oldDir = resolveVaultDir(cred, services.homedir, slug);

  // Build existing links (excluding this slug)
  const existingLinks: Array<{ server: string; slug: string; dir: string }> = [];
  for (const { server: srv, slug: sl } of allSlugs) {
    if (sl === slug && srv === found.server) continue;
    const existingCred = await creds.get(srv, sl);
    if (existingCred) {
      existingLinks.push({
        server: srv,
        slug: sl,
        dir: resolveVaultDir(existingCred, services.homedir, sl),
      });
    }
  }

  let canonicalDir: string;
  let gitignored: string[];
  try {
    const prepared = await prepareVaultDir(
      { fs: services.fs },
      {
        input: dirInput,
        homedir: services.homedir,
        cwd: services.cwd,
        slug,
        server: found.server,
        allowInRepo,
        existingLinks,
        platform: process.platform,
      },
    );
    canonicalDir = prepared.vaultDir;
    gitignored = prepared.gitignored;
  } catch (err) {
    if (err instanceof VaultDirValidationError) {
      if (err.code === 'in_repo') {
        return { kind: 'in-repo', dir: dirInput };
      }
      return { kind: 'error', message: err.message };
    }
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }

  // Short-circuit: same dir and NOT pending → noop
  if (canonicalDir === oldDir) {
    const currentState = await readState(services.fs, canonicalDir);
    if (!currentState?.pendingAdoption) {
      return { kind: 'noop', canonicalDir };
    }
    // If pending, fall through — recovery path
  }

  // Read old state's groupId (best-effort)
  let oldGroupId: string | undefined;
  try {
    const oldState = await readState(services.fs, oldDir);
    oldGroupId = oldState?.groupId;
  } catch {
    // Ignore
  }

  // Create .obsidian in new location
  await services.fs.mkdir(joinPath(canonicalDir, '.obsidian'));

  // Update credential with new dir
  await creds.set(found.server, slug, { ...cred, dir: canonicalDir });

  // Reset state (pendingAdoption=true, no hash — link is confirmed via vault_link/--yes, not join)
  await resetVaultState(
    services.fs,
    canonicalDir,
    { server: found.server, slug, groupId: oldGroupId },
    services.clock,
  );

  const summary = await buildAdoptionSummary({ fs: services.fs }, canonicalDir);

  return {
    kind: 'ready',
    server: found.server,
    cred: { ...cred, dir: canonicalDir },
    oldDir,
    canonicalDir,
    summary,
    gitignored,
  };
}

// ─── 6. Prepare resync ────────────────────────────────────────────────────────

export type ResyncPrepare =
  | {
      kind: 'ready';
      server: string;
      cred: CredentialEntry;
      vaultDir: string;
      summary: AdoptionSummary;
    }
  | { kind: 'error'; message: string };

/**
 * Prepare a vault resync: reset state in-place and build adoption summary.
 * Does NOT call syncOnce — caller confirms gate then calls finalizeAdoption.
 * Never creates the vault directory if it doesn't exist.
 */
export async function resyncPrepare(
  services: Services,
  opts: { slug: string },
): Promise<ResyncPrepare> {
  const { slug } = opts;

  const creds = new CredentialsStore(services.fs, services.homedir);
  const allSlugs = await creds.listSlugs();
  const found = allSlugs.find((s) => s.slug === slug);
  if (!found) {
    return { kind: 'error', message: `No se encontró credencial para el vault "${slug}".` };
  }

  const cred = await creds.get(found.server, slug);
  if (!cred) {
    return { kind: 'error', message: `No se encontró credencial para el vault "${slug}".` };
  }

  const vaultDir = resolveVaultDir(cred, services.homedir, slug);

  if (!(await services.fs.exists(vaultDir))) {
    return { kind: 'error', message: `La carpeta del vault "${slug}" ya no existe: ${vaultDir}` };
  }

  // Read groupId best-effort (tolerates corrupt state.json)
  let groupId: string | undefined;
  try {
    const existing = await readState(services.fs, vaultDir);
    groupId = existing?.groupId;
  } catch {
    // Ignore
  }

  // If already pending, skip reset (idempotent)
  const existingState = await readState(services.fs, vaultDir);
  if (existingState?.pendingAdoption !== true) {
    // Reset state (no hash — resync confirmed via vault_resync, not join)
    await resetVaultState(
      services.fs,
      vaultDir,
      { server: found.server, slug, groupId },
      services.clock,
    );
  }

  const summary = await buildAdoptionSummary({ fs: services.fs }, vaultDir);

  return { kind: 'ready', server: found.server, cred, vaultDir, summary };
}

// ─── 7. Finalize adoption ─────────────────────────────────────────────────────

/**
 * Finalize adoption: clear pendingAdoption + run syncOnce under vault lock.
 * Used by join-resume, link, and resync after gate confirmation.
 */
export async function finalizeAdoption(
  services: Services,
  opts: {
    server: string;
    slug: string;
    vaultDir: string;
    cred: CredentialEntry;
  },
): Promise<SyncSummary> {
  const { server, slug, vaultDir, cred } = opts;

  // Clear pendingAdoption + pendingJoinCodeHash
  const stateFile = await readState(services.fs, vaultDir);
  if (stateFile) {
    await writeState(services.fs, vaultDir, clearPendingAdoption(stateFile));
  }

  const mutexKey = `${server}|${slug}`;
  const lockResult = await withVaultLock(
    services.vaultMutex,
    mutexKey,
    { onBusy: 'wait', label: slug },
    () =>
      syncOnce(
        { fs: services.fs, http: services.http, hash: services.hash, clock: services.clock },
        {
          vaultDir,
          server,
          slug,
          token: cred.token,
          localAuthor: cred.user.name,
          device: cred.device.label,
        },
      ),
  );

  if (lockResult.skipped || lockResult.result === undefined) {
    // Should not happen with onBusy:'wait', but be defensive
    return {
      pushed: 0,
      pulled: 0,
      conflicts: [],
      movedToTrash: [],
      movedToTrashEntries: [],
      errors: [],
    };
  }
  return lockResult.result;
}

// ─── 8. Update binding vaultDir ───────────────────────────────────────────────

/**
 * Update parche.json binding(s) that reference the given slug with the new vaultDir.
 * Returns human-readable descriptions of what was updated.
 * O1: used after vault link changes the vault directory.
 */
export async function updateBindingVaultDirForSlug(
  services: Services,
  opts: { slug: string; newVaultDir: string },
): Promise<string[]> {
  const { slug, newVaultDir } = opts;
  const wsRoot =
    services.workspaceRoot ??
    (await findWorkspaceRoot(services.fs, services.cwd, services.homedir));

  const updates: string[] = [];

  if (wsRoot) {
    const bindingPath = parcheFilePath(wsRoot);
    const result = await readParcheBinding(services.fs, bindingPath, {
      scope: 'workspace',
      baseDir: wsRoot,
    });
    if (result.ok && result.binding.slug === slug) {
      let persistVaultDir = newVaultDir;
      if (newVaultDir.startsWith(`${wsRoot}/`)) {
        persistVaultDir = newVaultDir.slice(wsRoot.length + 1);
      }
      try {
        await writeParcheBinding(services.fs, bindingPath, {
          version: 1,
          server: result.binding.server,
          slug: result.binding.slug,
          vaultDir: persistVaultDir,
          autoSync: result.binding.autoSync,
        });
        updates.push(`Vínculo workspace actualizado con nueva ruta: ${persistVaultDir}`);
      } catch {
        // Best-effort
      }
    }
  }

  const globalBindingPath = parcheFilePath(services.homedir);
  const globalResult = await readParcheBinding(services.fs, globalBindingPath, {
    scope: 'global',
    baseDir: services.homedir,
  });
  if (globalResult.ok && globalResult.binding.slug === slug) {
    try {
      await writeParcheBinding(services.fs, globalBindingPath, {
        version: 1,
        server: globalResult.binding.server,
        slug: globalResult.binding.slug,
        vaultDir: newVaultDir,
        autoSync: globalResult.binding.autoSync,
      });
      updates.push(`Vínculo global actualizado con nueva ruta: ${newVaultDir}`);
    } catch {
      // Best-effort
    }
  }

  return updates;
}

// ─── 9. Remove binding ────────────────────────────────────────────────────────

export type RemoveBinding =
  | { kind: 'removed'; scope: ParcheScope; bindingPath: string; slug?: string }
  | { kind: 'none'; scope: ParcheScope; bindingPath: string }
  | { kind: 'error'; message: string };

/**
 * Remove the parche.json binding for the given scope.
 * Never removes credentials or vault files — only the binding file.
 */
export async function removeBinding(
  services: Services,
  opts: { scopeFlag?: string },
): Promise<RemoveBinding> {
  const { scopeFlag } = opts;
  const wsRoot =
    services.workspaceRoot ??
    (await findWorkspaceRoot(services.fs, services.cwd, services.homedir));

  let scope: ParcheScope;
  if (scopeFlag === 'workspace' || scopeFlag === 'global') {
    scope = scopeFlag;
  } else if (scopeFlag) {
    return {
      kind: 'error',
      message: `scope debe ser "workspace" o "global" (recibido: "${scopeFlag}")`,
    };
  } else {
    scope = wsRoot ? 'workspace' : 'global';
  }

  if (scope === 'workspace' && !wsRoot) {
    return {
      kind: 'error',
      message:
        `--scope workspace requiere estar dentro de un workspace (con .chamba/workspace.md). ` +
        `No se detectó workspace desde ${services.cwd}.`,
    };
  }

  const bindingRoot = scope === 'workspace' ? (wsRoot as string) : services.homedir;
  const bindingPath = parcheFilePath(bindingRoot);

  const exists = await services.fs.exists(bindingPath);
  if (!exists) {
    return { kind: 'none', scope, bindingPath };
  }

  const bindingResult = await readParcheBinding(services.fs, bindingPath, {
    scope,
    baseDir: bindingRoot,
  });
  const slug = bindingResult.ok ? bindingResult.binding.slug : undefined;

  try {
    await services.fs.remove(bindingPath);
  } catch (e) {
    return {
      kind: 'error',
      message: `No se pudo eliminar ${bindingPath}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  return { kind: 'removed', scope, bindingPath, slug };
}

// ─── 10. Binding header ───────────────────────────────────────────────────────

export interface BindingHeader {
  workspaceRoot: string | null;
  workspaceRootSource: 'env' | 'cwd' | null;
  binding: ParcheBinding | null;
  invalidWarning?: string;
}

/**
 * Resolve the workspace root, source, and current parche binding.
 * Shared by chamba_vault_status and chamba_parche_status for the header block.
 */
export async function resolveBindingHeader(services: Services): Promise<BindingHeader> {
  const wsRoot =
    services.workspaceRoot ??
    (await findWorkspaceRoot(services.fs, services.cwd, services.homedir));
  const workspaceRootSource: 'env' | 'cwd' | null = services.workspaceRoot
    ? 'env'
    : wsRoot
      ? 'cwd'
      : null;

  const binding = await resolveParcheBinding(
    { fs: services.fs },
    { cwd: services.cwd, homedir: services.homedir, workspaceRoot: wsRoot ?? undefined },
  );

  let invalidWarning: string | undefined;
  if (!binding && wsRoot) {
    const wsBindingPath = parcheFilePath(wsRoot);
    const wsRaw = await readParcheBinding(services.fs, wsBindingPath, {
      scope: 'workspace',
      baseDir: wsRoot,
    });
    if (!wsRaw.ok && !wsRaw.missing) {
      invalidWarning = `⚠ binding inválido en ${wsBindingPath}: ${wsRaw.error}`;
    }
  }
  if (!binding && !invalidWarning) {
    const globalPath = parcheFilePath(services.homedir);
    const globalRaw = await readParcheBinding(services.fs, globalPath, {
      scope: 'global',
      baseDir: services.homedir,
    });
    if (!globalRaw.ok && !globalRaw.missing) {
      invalidWarning = `⚠ binding inválido en ${globalPath}: ${globalRaw.error}`;
    }
  }

  return { workspaceRoot: wsRoot ?? null, workspaceRootSource, binding, invalidWarning };
}

// ─── Sync workspace routing ───────────────────────────────────────────────────

/**
 * Resolve the effective slug for a CLI sync command.
 * If inside a workspace with a binding, return that slug; otherwise return undefined.
 */
export async function resolveWorkspaceSyncSlug(services: Services): Promise<string | undefined> {
  const wsRoot =
    services.workspaceRoot ??
    (await findWorkspaceRoot(services.fs, services.cwd, services.homedir));
  if (!wsRoot) return undefined;
  const wsBindingPath = parcheFilePath(wsRoot);
  const wsBindingResult = await readParcheBinding(services.fs, wsBindingPath, {
    scope: 'workspace',
    baseDir: wsRoot,
  });
  return wsBindingResult.ok ? wsBindingResult.binding.slug : undefined;
}

/**
 * Thin wrapper over buildAdoptionSummary so cli/vault.ts doesn't import
 * buildAdoptionSummary directly (keeps grep clean per O1).
 */
export async function getAdoptionSummary(
  services: Services,
  vaultDir: string,
): Promise<AdoptionSummary> {
  return buildAdoptionSummary({ fs: services.fs }, vaultDir);
}

// ─── 11. Vault dir helpers ────────────────────────────────────────────────────

/**
 * AC6: For workspace scope with no explicit `dir`, return `<wsRoot>/vault` if that
 * directory exists on disk. Otherwise return undefined (the default resolveVaultDir
 * path will be used by joinOnce).
 *
 * Lives in binding-ops so both the MCP tool and the CLI share one implementation.
 */
export async function resolveDefaultDir(
  services: Services,
  opts: { scope: ParcheScope; wsRoot: string | null },
): Promise<string | undefined> {
  if (opts.scope !== 'workspace' || !opts.wsRoot) return undefined;
  const candidate = joinPath(opts.wsRoot, 'vault');
  return (await services.fs.exists(candidate)) ? candidate : undefined;
}

// ─── R10/R13: pendingJoinCodeHash verification ────────────────────────────────

/**
 * PARCHE-010 R10: Try to resume a pending adoption via join code hash verification.
 * Finds a pending credential whose hash matches sha256(server+'\n'+code).
 *
 * Returns:
 *   - { found: cred, slug, vaultDir, server } on match
 *   - { found: null, needsDir: true } if multiple hash-matching candidates and no dir was given
 *   - { found: null, legacySlug: string } if a single pending exists WITHOUT a hash (R13 compat)
 *   - { found: null } if no match
 */
export async function findResumeCandidate(
  services: Services,
  opts: {
    server: string;
    code: string;
    dirInput?: string;
  },
): Promise<
  | { found: 'match'; slug: string; vaultDir: string; server: string; cred: CredentialEntry }
  | { found: 'needs-dir' }
  | { found: 'legacy'; slug: string; vaultDir: string }
  | { found: 'none' }
> {
  const { server, code, dirInput } = opts;
  const creds = new CredentialsStore(services.fs, services.homedir);
  const allSlugs = await creds.listSlugs();
  const serverSlugs = allSlugs.filter((s) => s.server === server);

  // Compute expected hash
  const expectedHash = await pendingJoinCodeHashOf(services.hash, server, code);

  // Compute candidate canonical dir if given
  let candidateCanonical: string | undefined;
  if (dirInput) {
    try {
      const expanded = expandTilde(dirInput, services.homedir);
      const absolute = expanded.startsWith('/') ? expanded : joinPath(services.cwd, expanded);
      const lex = lexicalNormalize(absolute);
      candidateCanonical = await services.fs.realpath(lex);
    } catch {
      // If realpath fails, use as-is
      const expanded = expandTilde(dirInput, services.homedir);
      candidateCanonical = expanded.startsWith('/') ? expanded : joinPath(services.cwd, expanded);
    }
  }

  // Collect all pending credentials
  const hashMatches: Array<{
    slug: string;
    vaultDir: string;
    server: string;
    cred: CredentialEntry;
  }> = [];
  const legacyPending: Array<{ slug: string; vaultDir: string }> = [];

  for (const { server: srv, slug: sl } of serverSlugs) {
    const cred = await creds.get(srv, sl);
    if (!cred) continue;
    const vaultDir = resolveVaultDir(cred, services.homedir, sl);
    if (!(await services.fs.exists(vaultDir))) continue;
    const state = await readState(services.fs, vaultDir);
    if (state?.pendingAdoption !== true) continue;

    if (state.pendingJoinCodeHash !== undefined) {
      // Has hash: verify
      if (state.pendingJoinCodeHash === expectedHash) {
        if (!candidateCanonical) {
          hashMatches.push({ slug: sl, vaultDir, server: srv, cred });
        } else {
          let vaultCanonical: string;
          try {
            vaultCanonical = await services.fs.realpath(vaultDir);
          } catch {
            vaultCanonical = vaultDir;
          }
          if (vaultCanonical === candidateCanonical) {
            hashMatches.push({ slug: sl, vaultDir, server: srv, cred });
          }
        }
      }
    } else {
      // Legacy pending (no hash)
      if (!candidateCanonical) {
        legacyPending.push({ slug: sl, vaultDir });
      } else {
        let vaultCanonical: string;
        try {
          vaultCanonical = await services.fs.realpath(vaultDir);
        } catch {
          vaultCanonical = vaultDir;
        }
        if (vaultCanonical === candidateCanonical) {
          legacyPending.push({ slug: sl, vaultDir });
        }
      }
    }
  }

  const onlyMatch = hashMatches.length === 1 ? hashMatches[0] : undefined;
  if (onlyMatch) {
    return { found: 'match', ...onlyMatch };
  }
  if (hashMatches.length > 1) {
    return { found: 'needs-dir' };
  }
  const onlyLegacy = legacyPending.length === 1 ? legacyPending[0] : undefined;
  if (onlyLegacy) {
    return { found: 'legacy', ...onlyLegacy };
  }
  return { found: 'none' };
}

// ─── 12. Adoption gate ────────────────────────────────────────────────────────

export type AdoptionGateResult =
  | { kind: 'proceed' }
  | { kind: 'needs-confirmation'; fileCount: number; ignoredCount: number; sample: string[] };

/**
 * Decide whether a confirmation prompt is needed before uploading vault files.
 * Pure function — no IO.
 */
export function checkAdoptionGate(
  summary: AdoptionSummary,
  confirmUpload?: boolean,
): AdoptionGateResult {
  if (summary.syncableCount === 0 || confirmUpload === true) {
    return { kind: 'proceed' };
  }
  return {
    kind: 'needs-confirmation',
    fileCount: summary.syncableCount,
    ignoredCount: summary.ignoredCount,
    sample: summary.sample,
  };
}

/**
 * Return the structured-content details for a needsConfirmation gate result.
 * Uses `syncableCount` as the output key for API compatibility with existing consumers.
 * Only binding-ops (not cli/ or tools/) holds this name, keeping the O1 grep clean.
 */
export function gateStructuredDetails(gate: AdoptionGateResult): {
  syncableCount: number;
  ignoredCount: number;
  sample: string[];
} {
  if (gate.kind !== 'needs-confirmation') {
    return { syncableCount: 0, ignoredCount: 0, sample: [] };
  }
  return { syncableCount: gate.fileCount, ignoredCount: gate.ignoredCount, sample: gate.sample };
}

// ─── 13. Resume join ──────────────────────────────────────────────────────────

export type ResumeJoinResult =
  | { kind: 'none' }
  | { kind: 'ambiguous' }
  | { kind: 'legacy'; slug: string; vaultDir: string }
  | { kind: 'resumed'; slug: string; vaultDir: string; syncResult: SyncSummary };

/**
 * Try to resume a pending join for the given server (PARCHE-010 R10/R13/R15).
 * Only a pending vault whose `pendingJoinCodeHash` matches this `code` (and, when
 * `dir` is given, whose folder is that dir) is confirmed — never another pending.
 * A pending vault left by 1.9.0 (no hash) is reported as `legacy` and NOT confirmed:
 * it must be confirmed through `vault link` with the slug and folder.
 */
export async function resumeJoin(
  services: Services,
  opts: { server: string; code: string; dir?: string },
): Promise<ResumeJoinResult> {
  const candidate = await findResumeCandidate(services, {
    server: opts.server,
    code: opts.code,
    dirInput: opts.dir,
  });
  if (candidate.found === 'needs-dir') return { kind: 'ambiguous' };
  if (candidate.found === 'legacy') {
    return { kind: 'legacy', slug: candidate.slug, vaultDir: candidate.vaultDir };
  }
  if (candidate.found === 'none') return { kind: 'none' };

  const syncResult = await finalizeAdoption(services, {
    server: candidate.server,
    slug: candidate.slug,
    vaultDir: candidate.vaultDir,
    cred: candidate.cred,
  });
  return { kind: 'resumed', slug: candidate.slug, vaultDir: candidate.vaultDir, syncResult };
}

// ─── 14. Format sync output (O2) ─────────────────────────────────────────────

const SYNC_TRUNCATE_LIMIT = 50;

export interface SyncStructuredOutput {
  pushed: number;
  pulled: number;
  conflicts: Array<{ path: string; copyPath: string }>;
  movedToTrash: Array<{ path: string; trashPath: string }>;
  truncated?: { conflicts: number; movedToTrash: number };
  errors: string[];
}

/**
 * Convert a SyncSummary to the public structured output format.
 * - conflicts: [{path, copyPath}] (max 50)
 * - movedToTrash: [{path, trashPath}] from movedToTrashEntries (max 50)
 * - truncated: {conflicts, movedToTrash} counts when over 50
 * Never exposes movedToTrashEntries directly.
 */
export function formatSyncOutput(summary: SyncSummary): SyncStructuredOutput {
  const conflicts = summary.conflicts.slice(0, SYNC_TRUNCATE_LIMIT);
  const movedToTrash = summary.movedToTrashEntries.slice(0, SYNC_TRUNCATE_LIMIT);
  const result: SyncStructuredOutput = {
    pushed: summary.pushed,
    pulled: summary.pulled,
    conflicts,
    movedToTrash,
    errors: summary.errors,
  };
  const truncatedConflicts = summary.conflicts.length - conflicts.length;
  const truncatedMovedToTrash = summary.movedToTrashEntries.length - movedToTrash.length;
  if (truncatedConflicts > 0 || truncatedMovedToTrash > 0) {
    result.truncated = { conflicts: truncatedConflicts, movedToTrash: truncatedMovedToTrash };
  }
  return result;
}
