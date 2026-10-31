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
  buildAdoptionSummary,
  CredentialsStore,
  findWorkspaceRoot,
  joinFirstHint,
  joinOnce,
  joinPath,
  linkDirPlaceholderHint,
  linkHint,
  MEMORY_DIR,
  ParcheAlreadyMemberError,
  ParcheClient,
  ParcheNotFoundError,
  ParcheRateLimitedError,
  parcheFilePath,
  parseJoinInput,
  planPush,
  prepareVaultDir,
  readParcheBinding,
  readState,
  resetVaultState,
  resolveServerUrl,
  resolveVaultDir,
  scanLocal,
  syncOnce,
  toSyncState,
  unlinkWorkspaceHint,
  VaultDirMissingError,
  VaultDirValidationError,
  writeParcheBinding,
  writeState,
} from '@chamba/core';
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
  hasYes: boolean,
  deps: VaultCliDeps,
): Promise<boolean> {
  const { services, stdout, stderr, exit, prompt, isTTY } = deps;

  const summary = await buildAdoptionSummary({ fs: services.fs }, vaultDir);
  if (summary.syncableCount === 0) return true; // empty vault, no gate needed

  // Print summary
  stdout(`El vault "${vaultDir}" tiene ${summary.syncableCount} archivo(s) sincronizable(s).`);
  stdout(`Archivos ignorados: ${summary.ignoredCount}`);
  if (summary.sample.length > 0) {
    stdout(`Muestra (primeros ${summary.sample.length}):`);
    for (const p of summary.sample) {
      stdout(`  - ${p}`);
    }
  }

  if (hasYes) return true;

  if (isTTY) {
    const answer = await prompt(
      `¿Subir ${summary.syncableCount} archivo(s) al parche "${slug}"? [s/N] `,
    );
    if (answer.trim().toLowerCase() === 's') return true;
    stdout(
      `No se subió nada. Para confirmar más tarde: ${linkHint(slug, vaultDir, { yes: true })}`,
    );
    return false;
  }

  // No TTY, no --yes: print instructions and exit 1
  stderr(
    `Hay ${summary.syncableCount} archivo(s) en "${vaultDir}" que se subirían al parche "${slug}".`,
  );
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

  // ── PARCHE-011: workspace scope resolution ─────────────────────────────────
  const wsRoot =
    services.workspaceRoot ??
    (await findWorkspaceRoot(services.fs, services.cwd, services.homedir));

  // Determine scope
  let scope: 'workspace' | 'global';
  if (scopeFlag === 'workspace' || scopeFlag === 'global') {
    scope = scopeFlag;
    if (scope === 'workspace' && !wsRoot) {
      stderr(
        `--scope workspace requiere estar dentro de un workspace (con .chamba/workspace.md). ` +
          `No se detectó workspace desde ${services.cwd}.`,
      );
      exit(1);
      return;
    }
  } else if (!scopeFlag) {
    if (!wsRoot) {
      // No workspace found → global
      scope = 'global';
    } else if (!isTTY) {
      // AC3: no TTY + in workspace + no --scope → exit 1
      stderr(
        `Estás dentro de un workspace (${wsRoot}). ` +
          `Usa --scope workspace o --scope global para especificar dónde guardar el vínculo. ` +
          `Sin --scope, este comando requiere TTY interactivo.`,
      );
      exit(1);
      return;
    } else {
      // TTY prompt
      const answer = await prompt(
        `¿Vincular este parche a este workspace (${wsRoot}/.chamba/parche.json) o como global? [workspace/global] `,
      );
      scope = answer.trim().toLowerCase().startsWith('w') ? 'workspace' : 'global';
    }
  } else {
    stderr(`--scope debe ser "workspace" o "global" (recibido: "${scopeFlag}")`);
    exit(1);
    return;
  }

  // AC4/R4: if workspace scope and binding already exists, pre-check invite via GET endpoint
  if (scope === 'workspace' && wsRoot) {
    const existingBindingPath = parcheFilePath(wsRoot);
    const existingBindingResult = await readParcheBinding(services.fs, existingBindingPath, {
      scope: 'workspace',
      baseDir: wsRoot,
    });
    if (existingBindingResult.ok) {
      // Pre-validate the invite code to see if slug matches
      // (requires server to be known — parse it first)
      let preServer: string | undefined;
      try {
        const preParsed = parseJoinInput(codeOrLink);
        preServer = resolveServerUrl({
          linkServer: preParsed.server,
          envUrl: services.parcheServerUrl,
          flagServer: serverFlag,
        });
      } catch {
        // If server can't be resolved yet, fall through to later error
      }

      if (preServer) {
        // Parse the code from codeOrLink (inline, before the outer parseJoinInput call)
        let preCode = codeOrLink;
        try {
          const preParsed2 = parseJoinInput(codeOrLink);
          preCode = preParsed2.code;
        } catch {
          // Use raw codeOrLink as code
        }
        const checkResult = await ParcheClient.checkInvite(services.http, preServer, preCode);
        if (checkResult.status === 'invalid') {
          stderr('código inválido, vencido o agotado');
          exit(1);
          return;
        }
        if (checkResult.status === 'not-found') {
          // Conservative: don't reveal workspace state; hint to unlink
          stderr(
            `No se pudo verificar el código — el servidor no reconoce la invitación. ` +
              `Si quieres vincular a otro parche, primero usa \`${unlinkWorkspaceHint()}\`.`,
          );
          exit(1);
          return;
        }
        if (checkResult.status === 'network-error') {
          // R13: no hint on transient errors
          stderr(`No pude verificar el código (red/servidor): ${checkResult.message}. Reintenta.`);
          exit(1);
          return;
        }
        // valid: check slug
        if (checkResult.slug !== existingBindingResult.binding.slug) {
          stderr(
            `Este workspace ya está vinculado al parche "${existingBindingResult.binding.slug}", ` +
              `pero el código es para "${checkResult.slug}". ` +
              `Usa \`${unlinkWorkspaceHint()}\` para desvincular primero.`,
          );
          exit(1);
          return;
        }
        // Same slug → allow re-join (e.g. new device)
      } else {
        // Can't resolve server yet → reject conservatively
        stderr(
          `Este workspace ya está vinculado al parche "${existingBindingResult.binding.slug}". ` +
            `Usa \`${unlinkWorkspaceHint()}\` para re-vincular.`,
        );
        exit(1);
        return;
      }
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
    stderr(err instanceof Error ? err.message : String(err));
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

  // If --dir: validate the directory first
  let canonicalDir: string | undefined;
  if (effectiveDirFlag) {
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
          input: effectiveDirFlag,
          homedir: services.homedir,
          cwd: services.cwd,
          slug: 'temp', // slug not known yet
          server: server_,
          allowInRepo,
          existingLinks,
          platform: process.platform,
        },
      );
      canonicalDir = prepared.vaultDir;
      if (prepared.gitignored.length > 0) {
        stdout(`Añadido a .gitignore: ${prepared.gitignored.join(', ')}`);
      }
    } catch (err) {
      if (err instanceof VaultDirValidationError) {
        stderr(err.message);
      } else {
        stderr(err instanceof Error ? err.message : String(err));
      }
      exit(1);
      return;
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

    // Run adoption gate
    const cred = await new CredentialsStore(services.fs, services.homedir).get(
      server_,
      result.slug,
    );
    const confirmed = await runAdoptionGate(result.vaultDir, result.slug, hasYes, deps);

    if (!confirmed) {
      // User declined — state stays with pendingAdoption=true
      stdout(`Vault "${result.slug}" creado en ${result.vaultDir} (sin sincronizar).`);
      stdout(
        `Para sincronizar más tarde: ${linkHint(result.slug, result.vaultDir, { yes: true })}`,
      );
      // Still write parche.json (binding exists even if not synced)
      await writeParcheJsonAfterJoin(
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

    // Confirmed: clear pendingAdoption and run first sync
    const stateFile = await readState(services.fs, result.vaultDir);
    if (stateFile?.pendingAdoption === true) {
      const cleared = { ...stateFile };
      delete cleared.pendingAdoption;
      await writeState(services.fs, result.vaultDir, cleared);
    }

    if (!cred) {
      stderr('Error interno: credencial no encontrada.');
      exit(1);
      return;
    }

    const syncResult = await syncOnce(
      { fs: services.fs, http: services.http, hash: services.hash, clock: services.clock },
      {
        vaultDir: result.vaultDir,
        server: server_,
        slug: result.slug,
        token: cred.token,
        localAuthor: cred.user.name,
        device: cred.device.label,
      },
    );

    stdout(`Unido al vault "${result.slug}" en ${result.vaultDir}`);
    stdout(
      `Primer sync: pushed ${syncResult.pushed}, pulled ${syncResult.pulled}, conflicts ${syncResult.conflicts.length}`,
    );

    // Write parche.json after successful join (R6: atomic write after joinOnce success)
    await writeParcheJsonAfterJoin(
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
    if (err instanceof ParcheNotFoundError) {
      msg = 'código inválido, vencido o agotado';
    } else if (err instanceof ParcheAlreadyMemberError) {
      msg = 'ya eres miembro en este grupo (próximamente: vault login para máquinas existentes)';
    } else if (err instanceof ParcheRateLimitedError) {
      msg = 'demasiados intentos, espera un minuto';
    } else {
      msg = err instanceof Error ? err.message : String(err);
    }
    stderr(msg);
    exit(1);
  }
}

/**
 * Write parche.json after a successful join (R6).
 * Returns false and writes to stderr + exits 1 on failure.
 */
async function writeParcheJsonAfterJoin(
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
  const bindingRoot = scope === 'workspace' ? wsRoot : services.homedir;
  if (!bindingRoot) return;

  // Determine vaultDir to persist: relative if inside the workspace, absolute otherwise
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
    stdout(`Vínculo ${scope} guardado en ${bindingPath}.`);
  } catch (e) {
    // R6: fail hard — show exact content so user can create it manually
    stderr(
      `Te uniste a ${slug} pero no se pudo escribir ${bindingPath}: ${e instanceof Error ? e.message : String(e)}.\n` +
        `Crea el archivo manualmente con este contenido:\n${bindingContent}`,
    );
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

  // Find the credential for this slug
  const creds = new CredentialsStore(services.fs, services.homedir);
  const allSlugs = await creds.listSlugs();
  const found = allSlugs.find((s) => s.slug === slug);
  if (!found) {
    stderr(`No se encontró credencial para el vault "${slug}".`);
    exit(1);
    return;
  }

  const cred = await creds.get(found.server, slug);
  if (!cred) {
    stderr(`No se encontró credencial para el vault "${slug}".`);
    exit(1);
    return;
  }

  // Get old dir (for informational message)
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

  // Validate and prepare new directory
  let canonicalDir: string;
  try {
    const prepared = await prepareVaultDir(
      { fs: services.fs },
      {
        input: dirFlag,
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
    if (prepared.gitignored.length > 0) {
      stdout(`Añadido a .gitignore: ${prepared.gitignored.join(', ')}`);
    }
  } catch (err) {
    if (err instanceof VaultDirValidationError) {
      stderr(err.message);
    } else {
      stderr(err instanceof Error ? err.message : String(err));
    }
    exit(1);
    return;
  }

  // Fix 5: if same dir and not pending, nothing to do
  if (canonicalDir === oldDir) {
    const currentState = await readState(services.fs, canonicalDir);
    if (!currentState?.pendingAdoption) {
      stdout(`Vault "${slug}" ya está vinculado a "${canonicalDir}"; nada que hacer.`);
      return;
    }
    // If pending, fall through: this is the recovery path
  }

  // Read old state's groupId (best-effort)
  let oldGroupId: string | undefined;
  try {
    const oldState = await readState(services.fs, oldDir);
    oldGroupId = oldState?.groupId;
  } catch {
    // Ignore
  }

  // Create .obsidian dir in new location
  await services.fs.mkdir(joinPath(canonicalDir, '.obsidian'));

  // Update credential with new dir
  await creds.set(found.server, slug, { ...cred, dir: canonicalDir });

  // Reset state in new dir (pendingAdoption=true)
  await resetVaultState(
    services.fs,
    canonicalDir,
    { server: found.server, slug, groupId: oldGroupId },
    services.clock,
  );

  if (oldDir !== canonicalDir) {
    stdout(`Nota: la ruta anterior "${oldDir}" sigue en disco intacta.`);
  }

  // Run adoption gate
  const confirmed = await runAdoptionGate(canonicalDir, slug, hasYes, deps);

  if (!confirmed) {
    stdout(`Vault "${slug}" re-vinculado a "${canonicalDir}" (sin sincronizar).`);
    stdout(`Para sincronizar: ${linkHint(slug, canonicalDir, { yes: true })}`);
    return;
  }

  // Confirmed: clear pendingAdoption and sync
  const stateFile = await readState(services.fs, canonicalDir);
  if (stateFile?.pendingAdoption === true) {
    const cleared = { ...stateFile };
    delete cleared.pendingAdoption;
    await writeState(services.fs, canonicalDir, cleared);
  }

  const syncResult = await syncOnce(
    { fs: services.fs, http: services.http, hash: services.hash, clock: services.clock },
    {
      vaultDir: canonicalDir,
      server: found.server,
      slug,
      token: cred.token,
      localAuthor: cred.user.name,
      device: cred.device.label,
    },
  );

  stdout(`Vault "${slug}" re-vinculado a "${canonicalDir}"`);
  stdout(
    `Sync: pushed ${syncResult.pushed}, pulled ${syncResult.pulled}, conflicts ${syncResult.conflicts.length}`,
  );

  // O1: if workspace or global binding exists for this slug, update its vaultDir
  await updateBindingVaultDir(services, slug, canonicalDir, stdout);
}

/**
 * O1: When vault link changes the vaultDir, update any parche.json binding
 * that references the same slug (workspace binding wins over global).
 */
async function updateBindingVaultDir(
  services: Services,
  slug: string,
  newVaultDir: string,
  stdout: (msg: string) => void,
): Promise<void> {
  const wsRoot =
    services.workspaceRoot ??
    (await findWorkspaceRoot(services.fs, services.cwd, services.homedir));

  let updated = 0;

  // Try workspace binding (no early return — always check global too)
  if (wsRoot) {
    const bindingPath = parcheFilePath(wsRoot);
    const result = await readParcheBinding(services.fs, bindingPath, {
      scope: 'workspace',
      baseDir: wsRoot,
    });
    if (result.ok && result.binding.slug === slug) {
      // Store relative path if inside workspace, absolute otherwise
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
        stdout(`Vínculo workspace actualizado con nueva ruta: ${persistVaultDir}`);
        updated++;
      } catch {
        // Best-effort: don't fail the link operation
      }
    }
  }

  // Try global binding (always checked, independent of workspace)
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
      stdout(`Vínculo global actualizado con nueva ruta: ${newVaultDir}`);
      updated++;
    } catch {
      // Best-effort
    }
  }

  if (updated === 0) {
    stdout('ningún parche.json actualizado');
  }
}

async function runSync(argv: string[], deps: VaultCliDeps): Promise<void> {
  const { services, stdout, stderr, exit } = deps;
  const slugArg = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;

  // PARCHE-011: if no explicit slug and inside a workspace with a binding, sync only binding slug
  let effectiveSlugArg = slugArg;
  if (!effectiveSlugArg) {
    const wsRoot =
      services.workspaceRoot ??
      (await findWorkspaceRoot(services.fs, services.cwd, services.homedir));
    if (wsRoot) {
      const wsBindingPath = parcheFilePath(wsRoot);
      const wsBindingResult = await readParcheBinding(services.fs, wsBindingPath, {
        scope: 'workspace',
        baseDir: wsRoot,
      });
      if (wsBindingResult.ok) {
        effectiveSlugArg = wsBindingResult.binding.slug;
      }
    }
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

  const scopeFlag = parseFlag(argv, '--scope') as 'workspace' | 'global' | undefined;

  // Resolve workspace root
  const wsRoot =
    services.workspaceRoot ??
    (await findWorkspaceRoot(services.fs, services.cwd, services.homedir));

  let scope: 'workspace' | 'global';
  if (scopeFlag === 'workspace' || scopeFlag === 'global') {
    scope = scopeFlag;
  } else if (scopeFlag) {
    stderr(`--scope debe ser "workspace" o "global" (recibido: "${scopeFlag}")`);
    exit(1);
    return;
  } else {
    // Default: workspace if inside one, else global
    scope = wsRoot ? 'workspace' : 'global';
  }

  if (scope === 'workspace' && !wsRoot) {
    stderr(
      `--scope workspace requiere estar dentro de un workspace (con .chamba/workspace.md). ` +
        `No se detectó workspace desde ${services.cwd}.`,
    );
    exit(1);
    return;
  }

  // wsRoot is non-null here because we've already validated scope=workspace→wsRoot exists
  const bindingRoot = scope === 'workspace' ? (wsRoot as string) : services.homedir;
  const bindingPath = parcheFilePath(bindingRoot);

  // Check that binding exists
  const exists = await services.fs.exists(bindingPath);
  if (!exists) {
    stdout(`No hay vínculo ${scope} en ${bindingPath}.`);
    exit(0);
    return;
  }

  // Read first so we can show the slug in the success message
  const bindingResult = await readParcheBinding(services.fs, bindingPath, {
    scope,
    baseDir: bindingRoot,
  });
  const slugDesc = bindingResult.ok ? ` (${bindingResult.binding.slug})` : '';

  // Delete the binding file
  try {
    await services.fs.remove(bindingPath);
  } catch (e) {
    stderr(`No se pudo eliminar ${bindingPath}: ${e instanceof Error ? e.message : String(e)}`);
    exit(1);
    return;
  }

  stdout(
    `Vínculo ${scope}${slugDesc} eliminado (${bindingPath}). ` +
      `Las credenciales y archivos del vault siguen intactos.`,
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
      // PARCHE-011: remove parche.json workspace/global binding
      await runUnlink(rest, deps);
      break;
    default: {
      const { stderr, exit } = deps;
      stderr(
        'Usage: vault <subcommand> [args]\n' +
          'Subcommands: join, link, sync, status, leave, unlink',
      );
      exit(1);
    }
  }
}
