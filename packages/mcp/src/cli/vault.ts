/**
 * cli/vault.ts — CLI implementation for `npx @chamba/mcp vault <subcommand>`.
 *
 * Subcommands:
 *   join <code|link> [--name --email --label --server --dir --allow-in-repo --yes]
 *   link <slug> --dir <ruta> [--allow-in-repo] [--yes]
 *   sync [slug]
 *   status
 *   leave <slug>
 *
 * All I/O is injectable via `VaultCliDeps` for tests.
 * The token is NEVER printed.
 */

import { hostname } from 'node:os';
import {
  AdoptionPendingError,
  CredentialsStore,
  InvalidJoinInputError,
  joinFirstHint,
  joinOnce,
  joinPath,
  linkDirPlaceholderHint,
  linkHint,
  MEMORY_DIR,
  ParcheAlreadyMemberError,
  ParcheNotFoundError,
  ParcheRateLimitedError,
  parseJoinInput,
  planPush,
  readState,
  resolveServerUrl,
  resolveVaultDir,
  scanLocal,
  syncOnce,
  toSyncState,
  VaultDirMissingError,
} from '@chamba/core';
import {
  type AdoptionGateResult,
  BindingWriteError,
  checkAdoptionGate,
  finalizeAdoption,
  getAdoptionSummary,
  persistBindingAfterJoin,
  precheckWorkspaceBinding,
  prepareJoinVaultDir,
  redactSecrets,
  relinkPrepare,
  removeBinding,
  resolveJoinScope,
  resolveWorkspaceSyncSlug,
  resyncPrepare,
  updateBindingVaultDirForSlug,
} from '../parche/binding-ops.js';
import type { Services } from '../services.js';

export interface VaultCliDeps {
  services: Services;
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
  exit: (code: number) => void;
  /** TTY prompter — inject for tests without a real TTY. */
  prompt: (question: string) => Promise<string>;
  /** Whether stdin is a TTY (default: process.stdin.isTTY). */
  isTTY: boolean;
  /**
   * Machine hostname used as the default device label.
   * Injectable so tests can assert the exact value without calling node:os.
   */
  hostname?: string;
}

// ─── Argument parsing helpers ─────────────────────────────────────────────────

function parseFlag(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx === -1) return undefined;
  return argv[idx + 1];
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

// ─── Adoption gate helper ─────────────────────────────────────────────────────

/**
 * Run the adoption gate for a vault directory that may have existing files.
 * Returns true if the user confirmed (or vault is empty), false if they declined.
 * Exits with code 1 and prints error if no TTY and no --yes.
 */
async function runAdoptionGate(
  vaultDir: string,
  slug: string,
  gate: AdoptionGateResult,
  hasYes: boolean,
  deps: VaultCliDeps,
): Promise<boolean> {
  const { stdout, stderr, exit, prompt, isTTY } = deps;

  if (gate.kind === 'proceed') return true;

  // gate.kind === 'needs-confirmation'
  stdout(`El vault "${vaultDir}" tiene ${gate.fileCount} archivo(s) sincronizable(s).`);
  stdout(`Archivos ignorados: ${gate.ignoredCount}`);
  if (gate.sample.length > 0) {
    stdout(`Muestra (primeros ${gate.sample.length}):`);
    for (const p of gate.sample) {
      stdout(`  - ${p}`);
    }
  }

  if (hasYes) return true;

  if (isTTY) {
    const answer = await prompt(`¿Subir ${gate.fileCount} archivo(s) al parche "${slug}"? [s/N] `);
    if (answer.trim().toLowerCase() === 's') return true;
    stdout(
      `No se subió nada. Para confirmar más tarde: ${linkHint(slug, vaultDir, { yes: true })}`,
    );
    return false;
  }

  // No TTY, no --yes: print instructions and exit 1
  stderr(`Hay ${gate.fileCount} archivo(s) en "${vaultDir}" que se subirían al parche "${slug}".`);
  stderr(`Para confirmar: ${linkHint(slug, vaultDir, { yes: true })}`);
  exit(1);
  return false;
}

// ─── Subcommands ──────────────────────────────────────────────────────────────

async function runJoin(argv: string[], deps: VaultCliDeps): Promise<void> {
  const { services, stdout, stderr, exit, prompt, isTTY } = deps;

  const codeOrLink = argv[0];
  if (!codeOrLink) {
    stderr(
      'Usage: vault join <code|link> [--name <name>] [--email <email>] [--label <label>] ' +
        '[--server <url>] [--dir <ruta>] [--scope workspace|global] [--allow-in-repo] [--yes]',
    );
    exit(1);
    return;
  }

  // Parse flags
  let name = parseFlag(argv, '--name');
  let email = parseFlag(argv, '--email');
  const labelFlag = parseFlag(argv, '--label');
  const serverFlag = parseFlag(argv, '--server');
  const dirFlag = parseFlag(argv, '--dir');
  const scopeFlag = parseFlag(argv, '--scope') as 'workspace' | 'global' | undefined;
  const allowInRepo = hasFlag(argv, '--allow-in-repo');
  const hasYes = hasFlag(argv, '--yes');

  // ── PARCHE-011: workspace scope resolution (via binding-ops) ────────────────
  const scopeResolution = await resolveJoinScope(services, scopeFlag);
  let scope: 'workspace' | 'global';
  let wsRoot: string | null;

  if (scopeResolution.kind === 'error') {
    stderr(scopeResolution.message);
    exit(1);
    return;
  } else if (scopeResolution.kind === 'needs-scope') {
    wsRoot = scopeResolution.wsRoot;
    if (!isTTY) {
      // AC3: no TTY + in workspace + no --scope → exit 1
      stderr(
        `Estás dentro de un workspace (${wsRoot}). ` +
          `Usa --scope workspace o --scope global para especificar dónde guardar el vínculo. ` +
          `Sin --scope, este comando requiere TTY interactivo.`,
      );
      exit(1);
      return;
    }
    // TTY prompt
    const answer = await prompt(
      `¿Vincular este parche a este workspace (${wsRoot}/.chamba/parche.json) o como global? [workspace/global] `,
    );
    scope = answer.trim().toLowerCase().startsWith('w') ? 'workspace' : 'global';
  } else {
    scope = scopeResolution.scope;
    wsRoot = scopeResolution.wsRoot;
  }

  // AC4/R4: if workspace scope and binding already exists, pre-check invite
  if (scope === 'workspace' && wsRoot) {
    const precheck = await precheckWorkspaceBinding(services, { wsRoot, codeOrLink, serverFlag });
    if (precheck.kind === 'reject') {
      stderr(precheck.message);
      exit(1);
      return;
    }
  }

  // TTY prompting for name/email
  if (!name || !email) {
    if (!isTTY) {
      stderr('--name y --email son obligatorios sin TTY');
      exit(1);
      return;
    }
    if (!name) name = await prompt('Nombre: ');
    if (!email) email = await prompt('Email: ');
  }

  // Resolve label
  const resolvedHostname = deps.hostname ?? hostname();
  const label = labelFlag !== undefined ? labelFlag : resolvedHostname;

  // Parse join input
  let parsed: ReturnType<typeof parseJoinInput>;
  try {
    parsed = parseJoinInput(codeOrLink);
  } catch (err) {
    // R1/AC4: never echo back the raw input (it may contain a pch_ token)
    if (err instanceof InvalidJoinInputError) {
      stderr('código o link inválido');
    } else {
      stderr(redactSecrets(err instanceof Error ? err.message : String(err)));
    }
    exit(1);
    return;
  }

  // Resolve server URL
  let server_: string;
  try {
    server_ = resolveServerUrl({
      linkServer: parsed.server,
      envUrl: services.parcheServerUrl,
      flagServer: serverFlag,
    });
  } catch (err) {
    stderr(err instanceof Error ? err.message : String(err));
    exit(1);
    return;
  }

  // Warn about personal memories
  try {
    const personalMemDir = joinPath(services.cwd, MEMORY_DIR);
    const entries = await services.fs.readDir(personalMemDir);
    const personalCount = entries.filter(
      (e) => e.isFile && e.name.toLowerCase().endsWith('.md'),
    ).length;
    if (personalCount > 0) {
      stdout(
        `⚠ Tienes ${personalCount} memoria(s) personal(es) en .chamba/memory/ — siguen siendo privadas y no se sincronizan al grupo.`,
      );
    }
  } catch {
    // Ignore
  }

  // ── vaultDir default for workspace scope ───────────────────────────────────
  // If no --dir and scope=workspace: try <wsRoot>/vault
  let effectiveDirFlag = dirFlag;
  if (!effectiveDirFlag && scope === 'workspace' && wsRoot) {
    const wsVaultDir = joinPath(wsRoot, 'vault');
    if (await services.fs.exists(wsVaultDir)) {
      effectiveDirFlag = wsVaultDir;
    }
  }

  // If --dir: validate the directory first (via binding-ops)
  let canonicalDir: string | undefined;
  if (effectiveDirFlag) {
    const prepResult = await prepareJoinVaultDir(services, {
      dirInput: effectiveDirFlag,
      allowInRepo,
      server: server_,
    });
    if (prepResult.kind === 'in-repo') {
      stderr(
        `La ruta "${effectiveDirFlag}" está dentro de un repositorio git. ` +
          `Usa --allow-in-repo para permitirlo.`,
      );
      exit(1);
      return;
    }
    if (prepResult.kind === 'error') {
      stderr(prepResult.message);
      exit(1);
      return;
    }
    canonicalDir = prepResult.canonicalDir;
    if (prepResult.gitignored.length > 0) {
      stdout(`Añadido a .gitignore: ${prepResult.gitignored.join(', ')}`);
    }
  }

  try {
    const result = await joinOnce(
      { fs: services.fs, http: services.http, hash: services.hash, clock: services.clock },
      {
        vaultDir: canonicalDir,
        server: server_,
        homedir: services.homedir,
        joinRequest: {
          code: parsed.code,
          name,
          email,
          ...(label ? { deviceLabel: label } : {}),
        },
        // D1: universal gate — always skipInitialSync
        skipInitialSync: true,
      },
    );

    // Compute adoption summary via binding-ops (keeps buildAdoptionSummary out of cli/)
    const summary = await getAdoptionSummary(services, result.vaultDir);

    // Run adoption gate
    const cred = await new CredentialsStore(services.fs, services.homedir).get(
      server_,
      result.slug,
    );
    const gate = checkAdoptionGate(summary);
    const confirmed = await runAdoptionGate(result.vaultDir, result.slug, gate, hasYes, deps);

    if (!confirmed) {
      // User declined — state stays with pendingAdoption=true
      stdout(`Vault "${result.slug}" creado en ${result.vaultDir} (sin sincronizar).`);
      stdout(
        `Para sincronizar más tarde: ${linkHint(result.slug, result.vaultDir, { yes: true })}`,
      );
      // Still write parche.json (binding exists even if not synced)
      await writeBindingAfterJoinCli(
        services,
        scope,
        wsRoot,
        server_,
        result.slug,
        result.vaultDir,
        stdout,
        stderr,
        exit,
      );
      return;
    }

    // Confirmed: finalize adoption via binding-ops (clears pendingAdoption + syncOnce)
    if (!cred) {
      stderr('Error interno: credencial no encontrada.');
      exit(1);
      return;
    }

    const syncResult = await finalizeAdoption(services, {
      server: server_,
      slug: result.slug,
      vaultDir: result.vaultDir,
      cred,
    });

    stdout(`Unido al vault "${result.slug}" en ${result.vaultDir}`);
    stdout(
      `Primer sync: pushed ${syncResult.pushed}, pulled ${syncResult.pulled}, conflicts ${syncResult.conflicts.length}`,
    );

    // Write parche.json after successful join (R6: via binding-ops)
    await writeBindingAfterJoinCli(
      services,
      scope,
      wsRoot,
      server_,
      result.slug,
      result.vaultDir,
      stdout,
      stderr,
      exit,
    );
  } catch (err) {
    let msg: string;
    if (err instanceof InvalidJoinInputError) {
      msg = 'código o link inválido';
    } else if (err instanceof ParcheNotFoundError) {
      msg = 'código inválido, vencido o agotado';
    } else if (err instanceof ParcheAlreadyMemberError) {
      msg = 'ya eres miembro en este grupo (próximamente: vault login para máquinas existentes)';
    } else if (err instanceof ParcheRateLimitedError) {
      msg = 'demasiados intentos, espera un minuto';
    } else {
      msg = redactSecrets(err instanceof Error ? err.message : String(err));
    }
    stderr(msg);
    exit(1);
  }
}

/**
 * Write parche.json after a join — wraps persistBindingAfterJoin with CLI messaging.
 * R6: fail hard if write fails, showing exact JSON content so user can create it manually.
 */
async function writeBindingAfterJoinCli(
  services: Services,
  scope: 'workspace' | 'global',
  wsRoot: string | null,
  server: string,
  slug: string,
  vaultDir: string,
  stdout: (msg: string) => void,
  stderr: (msg: string) => void,
  exit: (code: number) => void,
): Promise<void> {
  try {
    const res = await persistBindingAfterJoin(services, { scope, wsRoot, server, slug, vaultDir });
    if (res) {
      stdout(`Vínculo ${scope} guardado en ${res.bindingPath}.`);
    }
  } catch (e) {
    if (e instanceof BindingWriteError) {
      stderr(
        `Te uniste a ${slug} pero no se pudo escribir ${e.bindingPath}: ${(e.cause as Error | undefined)?.message ?? String(e.cause)}.\n` +
          `Crea el archivo manualmente con este contenido:\n${e.jsonContent}`,
      );
    } else {
      stderr(`Error escribiendo parche.json: ${e instanceof Error ? e.message : String(e)}`);
    }
    exit(1);
  }
}

/**
 * vault link <slug> --dir <nueva-ruta> [--allow-in-repo] [--yes]
 *
 * Re-links a vault to a new directory. Resets state, runs adoption gate,
 * and (if confirmed) runs syncOnce. Does NOT move or delete the old directory.
 */
async function runLink(argv: string[], deps: VaultCliDeps): Promise<void> {
  const { services, stdout, stderr, exit } = deps;

  const slug = argv[0];
  if (!slug) {
    stderr('Usage: vault link <slug> --dir <ruta> [--allow-in-repo] [--yes]');
    exit(1);
    return;
  }

  const dirFlag = parseFlag(argv, '--dir');
  if (!dirFlag) {
    stderr('--dir <ruta> es obligatorio para vault link');
    exit(1);
    return;
  }

  const allowInRepo = hasFlag(argv, '--allow-in-repo');
  const hasYes = hasFlag(argv, '--yes');

  // Validate dir, update credential, reset state — all via binding-ops
  const prep = await relinkPrepare(services, { slug, dirInput: dirFlag, allowInRepo });

  if (prep.kind === 'error') {
    stderr(prep.message);
    exit(1);
    return;
  }
  if (prep.kind === 'in-repo') {
    stderr(
      `La ruta "${dirFlag}" está dentro de un repositorio git. ` +
        `Usa --allow-in-repo para permitirlo.`,
    );
    exit(1);
    return;
  }
  if (prep.kind === 'noop') {
    stdout(`Vault "${slug}" ya está vinculado a "${prep.canonicalDir}"; nada que hacer.`);
    return;
  }

  // prep.kind === 'ready'
  const { server, cred, oldDir, canonicalDir, summary, gitignored } = prep;

  if (gitignored.length > 0) {
    stdout(`Añadido a .gitignore: ${gitignored.join(', ')}`);
  }
  if (oldDir !== canonicalDir) {
    stdout(`Nota: la ruta anterior "${oldDir}" sigue en disco intacta.`);
  }

  // Run adoption gate (summary already computed by relinkPrepare)
  const linkGate = checkAdoptionGate(summary);
  const confirmed = await runAdoptionGate(canonicalDir, slug, linkGate, hasYes, deps);

  if (!confirmed) {
    stdout(`Vault "${slug}" re-vinculado a "${canonicalDir}" (sin sincronizar).`);
    stdout(`Para sincronizar: ${linkHint(slug, canonicalDir, { yes: true })}`);
    return;
  }

  // Confirmed: finalize via binding-ops (clears pendingAdoption + syncOnce)
  const syncResult = await finalizeAdoption(services, {
    server,
    slug,
    vaultDir: canonicalDir,
    cred,
  });

  stdout(`Vault "${slug}" re-vinculado a "${canonicalDir}"`);
  stdout(
    `Sync: pushed ${syncResult.pushed}, pulled ${syncResult.pulled}, conflicts ${syncResult.conflicts.length}`,
  );

  // O1: update any parche.json binding that references this slug with new vaultDir
  const updates = await updateBindingVaultDirForSlug(services, { slug, newVaultDir: canonicalDir });
  for (const msg of updates) {
    stdout(msg);
  }
  if (updates.length === 0) {
    stdout('ningún parche.json actualizado');
  }
}

async function runSync(argv: string[], deps: VaultCliDeps): Promise<void> {
  const { services, stdout, stderr, exit } = deps;
  const slugArg = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;

  // PARCHE-011: if no explicit slug and inside a workspace with a binding, sync only binding slug
  let effectiveSlugArg = slugArg;
  if (!effectiveSlugArg) {
    effectiveSlugArg = await resolveWorkspaceSyncSlug(services);
  }

  const creds = new CredentialsStore(services.fs, services.homedir);
  const allSlugs = await creds.listSlugs();
  const targets = effectiveSlugArg ? allSlugs.filter((s) => s.slug === effectiveSlugArg) : allSlugs;

  if (targets.length === 0) {
    stderr(
      slugArg
        ? `No credential found for vault "${slugArg}".`
        : `No parche credentials found. Use \`${joinFirstHint()}\` first.`,
    );
    exit(1);
    return;
  }

  let anyError = false;
  for (const { server, slug } of targets) {
    try {
      const cred = await creds.get(server, slug);
      if (!cred) {
        stderr(`${slug}: no credential`);
        anyError = true;
        continue;
      }

      const vaultDir = resolveVaultDir(cred, services.homedir, slug);

      // PARCHE-009: check if vault dir exists
      const dirExists = await services.fs.exists(vaultDir);
      if (!dirExists) {
        stderr(
          `La carpeta ${vaultDir} del parche ${slug} ya no existe. Usa \`${linkDirPlaceholderHint(slug)}\`.`,
        );
        anyError = true;
        continue;
      }

      const state = await readState(services.fs, vaultDir);
      if (!state) {
        stderr(`${slug}: no state.json — run \`${joinFirstHint()}\` first`);
        anyError = true;
        continue;
      }

      // PARCHE-009: check pending adoption
      if (state.pendingAdoption === true) {
        stderr(
          `${slug}: pendiente de confirmar — corre \`${linkHint(slug, vaultDir, { yes: true })}\``,
        );
        anyError = true;
        continue;
      }

      const summary = await syncOnce(
        { fs: services.fs, http: services.http, hash: services.hash, clock: services.clock },
        {
          vaultDir,
          server,
          slug,
          token: cred.token,
          localAuthor: cred.user.name,
          device: cred.device.label,
        },
      );

      stdout(
        `${slug}: pushed ${summary.pushed}, pulled ${summary.pulled}, conflicts ${summary.conflicts.length}`,
      );
      if (summary.errors.length > 0) {
        stderr(`  errors: ${summary.errors.join('; ')}`);
        anyError = true;
      }
    } catch (err) {
      if (err instanceof VaultDirMissingError) {
        stderr(`${slug}: ${err.message}`);
      } else if (err instanceof AdoptionPendingError) {
        stderr(`${slug}: ${err.message}`);
      } else {
        stderr(`${slug}: ${err instanceof Error ? err.message : String(err)}`);
      }
      anyError = true;
    }
  }

  if (anyError) exit(1);
}

async function runStatus(deps: VaultCliDeps): Promise<void> {
  const { services, stdout } = deps;

  const creds = new CredentialsStore(services.fs, services.homedir);
  const allSlugs = await creds.listSlugs();

  if (allSlugs.length === 0) {
    stdout(`No parche vaults found. Use \`${joinFirstHint()}\` first.`);
    return;
  }

  // Count personal memories
  try {
    const personalMemDir = joinPath(services.cwd, MEMORY_DIR);
    const entries = await services.fs.readDir(personalMemDir);
    const personalCount = entries.filter(
      (e) => e.isFile && e.name.toLowerCase().endsWith('.md'),
    ).length;
    if (personalCount > 0) {
      stdout(
        `⚠ ${personalCount} memoria(s) personal(es) en .chamba/memory/ — privadas, no se sincronizan.`,
      );
    }
  } catch {
    // No personal memory dir
  }

  for (const { server, slug } of allSlugs) {
    try {
      const cred = await creds.get(server, slug);
      if (!cred) continue;

      const vaultDir = resolveVaultDir(cred, services.homedir, slug);

      // PARCHE-009: check dir existence
      const dirExists = await services.fs.exists(vaultDir);
      const state = dirExists ? await readState(services.fs, vaultDir) : null;

      let pending = '?';
      if (!dirExists) {
        pending = `[carpeta ya no existe — ${linkDirPlaceholderHint(slug)}]`;
      } else if (state) {
        if (state.pendingAdoption === true) {
          pending = 'pendiente de confirmar';
        } else {
          try {
            const { snapshot } = await scanLocal(
              { fs: services.fs, hash: services.hash },
              vaultDir,
            );
            const pushEntries = planPush(toSyncState(state), snapshot);
            pending = String(pushEntries.length);
          } catch {
            pending = 'error';
          }
        }
      }

      stdout('---');
      stdout(`slug:      ${slug}`);
      stdout(`server:    ${server}`);
      stdout(`role:      ${cred.role}`);
      stdout(`last sync: ${state?.lastSyncAt ?? 'never'}`);
      stdout(`pending:   ${pending}${dirExists ? ' change(s)' : ''}`);
      stdout(`path:      ${vaultDir}`);
    } catch (err) {
      stdout(`${slug}: error — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function runLeave(argv: string[], deps: VaultCliDeps): Promise<void> {
  const { services, stdout, stderr, exit } = deps;

  const slug = argv[0];
  if (!slug) {
    stderr('Usage: vault leave <slug>');
    exit(1);
    return;
  }

  const creds = new CredentialsStore(services.fs, services.homedir);
  const allSlugs = await creds.listSlugs();
  const found = allSlugs.find((s) => s.slug === slug);

  if (!found) {
    stderr(`No credential found for vault "${slug}".`);
    exit(1);
    return;
  }

  // Get the cred to resolve the vault dir before removing
  const cred = await creds.get(found.server, slug);
  // resolveVaultDir handles the default path when cred.dir is not set
  const vaultDir = cred
    ? resolveVaultDir(cred, services.homedir, slug)
    : resolveVaultDir({}, services.homedir, slug);

  // Remove only the credential — files stay intact (AC12)
  await creds.remove(found.server, slug);

  stdout(`Credencial eliminada para "${slug}".`);
  const dirExists = await services.fs.exists(vaultDir);
  if (dirExists) {
    stdout(`Los archivos del vault siguen en: ${vaultDir}`);
  } else {
    stdout(`La carpeta ${vaultDir} ya no existe.`);
  }
}

// ─── runUnlink ────────────────────────────────────────────────────────────────

/**
 * Removes the parche.json binding for the specified scope.
 * Does NOT remove credentials or vault files — only the binding file.
 * Usage: npx @chamba/mcp vault unlink [--scope workspace|global]
 */
async function runUnlink(argv: string[], deps: VaultCliDeps): Promise<void> {
  const { services, stdout, stderr, exit } = deps;

  const scopeFlag = parseFlag(argv, '--scope');

  // Delegate all resolution and deletion to binding-ops
  const result = await removeBinding(services, { scopeFlag });

  if (result.kind === 'error') {
    stderr(result.message);
    exit(1);
    return;
  }

  if (result.kind === 'none') {
    stdout(`No hay vínculo ${result.scope} en ${result.bindingPath}.`);
    exit(0);
    return;
  }

  // result.kind === 'removed'
  const slugDesc = result.slug ? ` (${result.slug})` : '';
  stdout(
    `Vínculo ${result.scope}${slugDesc} eliminado (${result.bindingPath}). ` +
      `Las credenciales y archivos del vault siguen intactos.`,
  );
}

// ─── runResync ────────────────────────────────────────────────────────────────

/**
 * vault resync <slug> [--yes]
 *
 * PARCHE-010 O3: Reset state in-place and re-adopt a vault (re-download from server).
 * Useful when local state is corrupted or the vault dir was replaced.
 * Does NOT change the vault directory or credentials.
 */
async function runResync(argv: string[], deps: VaultCliDeps): Promise<void> {
  const { services, stdout, stderr, exit } = deps;

  const slug = argv[0];
  if (!slug) {
    stderr('Usage: vault resync <slug> [--yes]');
    exit(1);
    return;
  }

  const hasYes = hasFlag(argv, '--yes');

  const prep = await resyncPrepare(services, { slug });

  if (prep.kind === 'error') {
    stderr(prep.message);
    exit(1);
    return;
  }

  const { server, cred, vaultDir, summary } = prep;

  // Run adoption gate
  const resyncGate = checkAdoptionGate(summary);
  const confirmed = await runAdoptionGate(vaultDir, slug, resyncGate, hasYes, deps);

  if (!confirmed) {
    stdout(`Vault "${slug}" marcado para resync en "${vaultDir}" (sin sincronizar).`);
    stdout(`Para sincronizar: ${linkHint(slug, vaultDir, { yes: true })}`);
    return;
  }

  // Confirmed: finalize adoption (clear pendingAdoption + syncOnce)
  const syncResult = await finalizeAdoption(services, { server, slug, vaultDir, cred });

  stdout(`Vault "${slug}" re-sincronizado en "${vaultDir}"`);
  stdout(
    `Sync: pushed ${syncResult.pushed}, pulled ${syncResult.pulled}, conflicts ${syncResult.conflicts.length}`,
  );
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

/**
 * Run the vault CLI.
 *
 * @param argv     - Arguments after `vault` (e.g. `['join', 'K7QX-M2RP', '--name', 'Joys']`).
 * @param deps     - Injectable deps for testing.
 */
export async function runVaultCli(argv: string[], deps: VaultCliDeps): Promise<void> {
  const subcommand = argv[0];
  const rest = argv.slice(1);

  switch (subcommand) {
    case 'join':
      await runJoin(rest, deps);
      break;
    case 'link':
      await runLink(rest, deps);
      break;
    case 'sync':
      await runSync(rest, deps);
      break;
    case 'status':
      await runStatus(deps);
      break;
    case 'leave':
      await runLeave(rest, deps);
      break;
    case 'unlink':
      // PARCHE-010: remove parche.json workspace/global binding
      await runUnlink(rest, deps);
      break;
    case 'resync':
      // PARCHE-010 O3: reset state + re-adopt in-place
      await runResync(rest, deps);
      break;
    default: {
      const { stderr, exit } = deps;
      stderr(
        'Usage: vault <subcommand> [args]\n' +
          'Subcommands: join, link, sync, status, leave, unlink, resync',
      );
      exit(1);
    }
  }
}
