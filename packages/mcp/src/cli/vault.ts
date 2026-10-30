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
  joinOnce,
  joinPath,
  MEMORY_DIR,
  ParcheAlreadyMemberError,
  ParcheNotFoundError,
  ParcheRateLimitedError,
  parseJoinInput,
  planPush,
  prepareVaultDir,
  readState,
  resetVaultState,
  resolveServerUrl,
  resolveVaultDir,
  scanLocal,
  syncOnce,
  toSyncState,
  VaultDirMissingError,
  VaultDirValidationError,
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
      `No se subió nada. Para confirmar más tarde: vault link ${slug} --dir "${vaultDir}" --yes`,
    );
    return false;
  }

  // No TTY, no --yes: print instructions and exit 1
  stderr(
    `Hay ${summary.syncableCount} archivo(s) en "${vaultDir}" que se subirían al parche "${slug}".`,
  );
  stderr(`Para confirmar: vault link ${slug} --dir "${vaultDir}" --yes`);
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
        '[--server <url>] [--dir <ruta>] [--allow-in-repo] [--yes]',
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
  const allowInRepo = hasFlag(argv, '--allow-in-repo');
  const hasYes = hasFlag(argv, '--yes');

  // TTY prompting
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

  // If --dir: validate the directory first
  let canonicalDir: string | undefined;
  if (dirFlag) {
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
          input: dirFlag,
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
        // D1: universal gate — always skipInitialSync if there's a custom dir
        // For default dir join, also skipInitialSync (apply gate universally)
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
        `Para sincronizar más tarde: vault link ${result.slug} --dir "${result.vaultDir}" --yes`,
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
  } catch (err) {
    let msg: string;
    if (err instanceof ParcheNotFoundError) {
      msg = 'código inválido, vencido o agotado';
    } else if (err instanceof ParcheAlreadyMemberError) {
      msg = 'ya eres miembro: usa `vault login` en esta máquina (próximamente)';
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
    stdout(`Para sincronizar: vault link ${slug} --dir "${canonicalDir}" --yes`);
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
}

async function runSync(argv: string[], deps: VaultCliDeps): Promise<void> {
  const { services, stdout, stderr, exit } = deps;
  const slugArg = argv[0] && !argv[0].startsWith('--') ? argv[0] : undefined;

  const creds = new CredentialsStore(services.fs, services.homedir);
  const allSlugs = await creds.listSlugs();
  const targets = slugArg ? allSlugs.filter((s) => s.slug === slugArg) : allSlugs;

  if (targets.length === 0) {
    stderr(
      slugArg
        ? `No credential found for vault "${slugArg}".`
        : 'No parche credentials found. Use vault join first.',
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
          `La carpeta ${vaultDir} del parche ${slug} ya no existe. Usa \`chamba vault link ${slug} --dir <ruta>\`.`,
        );
        anyError = true;
        continue;
      }

      const state = await readState(services.fs, vaultDir);
      if (!state) {
        stderr(`${slug}: no state.json — run vault join first`);
        anyError = true;
        continue;
      }

      // PARCHE-009: check pending adoption
      if (state.pendingAdoption === true) {
        stderr(
          `${slug}: pendiente de confirmar — corre \`vault link ${slug} --dir "${vaultDir}" --yes\``,
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
    stdout('No parche vaults found. Use vault join first.');
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
        pending = `[carpeta ya no existe — chamba vault link ${slug} --dir <ruta>]`;
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
    default: {
      const { stderr, exit } = deps;
      stderr('Usage: vault <subcommand> [args]\n' + 'Subcommands: join, link, sync, status, leave');
      exit(1);
    }
  }
}
