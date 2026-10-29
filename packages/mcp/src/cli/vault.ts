/**
 * cli/vault.ts — CLI implementation for `npx @chamba/mcp vault <subcommand>`.
 *
 * Subcommands:
 *   join <code|link> [--name --email --label --server]
 *   sync [slug]
 *   status
 *   leave <slug>
 *
 * All I/O is injectable via `VaultCliDeps` for tests.
 * The token is NEVER printed.
 */

import { hostname } from 'node:os';
import {
  CredentialsStore,
  joinOnce,
  joinPath,
  MEMORY_DIR,
  ParcheAlreadyMemberError,
  ParcheNotFoundError,
  ParcheRateLimitedError,
  parseJoinInput,
  planPush,
  readState,
  resolveServerUrl,
  scanLocal,
  syncOnce,
  toSyncState,
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

// ─── Subcommands ──────────────────────────────────────────────────────────────

async function runJoin(argv: string[], deps: VaultCliDeps): Promise<void> {
  const { services, stdout, stderr, exit, prompt, isTTY } = deps;

  const codeOrLink = argv[0];
  if (!codeOrLink) {
    stderr(
      'Usage: vault join <code|link> [--name <name>] [--email <email>] [--label <label>] [--server <url>]',
    );
    exit(1);
    return;
  }

  // Parse flags
  let name = parseFlag(argv, '--name');
  let email = parseFlag(argv, '--email');
  const labelFlag = parseFlag(argv, '--label');
  const serverFlag = parseFlag(argv, '--server');

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

  // Resolve label: use flag if provided (even empty), else use the injected/real hostname
  // If empty after all, omit from the request (gate rule)
  const resolvedHostname = deps.hostname ?? hostname();
  const label = labelFlag !== undefined ? labelFlag : resolvedHostname;

  // Parse join input (code or link)
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

  // Warn about personal memories (use readDir: recall('') always returns [] for empty query)
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
    // Ignore if no personal memories directory exists
  }

  try {
    const result = await joinOnce(
      { fs: services.fs, http: services.http, hash: services.hash, clock: services.clock },
      {
        vaultDir: '',
        server: server_,
        homedir: services.homedir,
        joinRequest: {
          code: parsed.code,
          name,
          email,
          // Omit label when empty (gate rule)
          ...(label ? { deviceLabel: label } : {}),
        },
      },
    );

    stdout(`Unido al vault "${result.slug}" en ${result.vaultDir}`);
    stdout(
      `Primer sync: pushed ${result.summary.pushed}, pulled ${result.summary.pulled}, conflicts ${result.summary.conflicts.length}`,
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

      const vaultDir = `${services.homedir}/.chamba/vaults/${slug}`;
      const state = await readState(services.fs, vaultDir);
      if (!state) {
        stderr(`${slug}: no state.json — run vault join first`);
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
      stderr(`${slug}: ${err instanceof Error ? err.message : String(err)}`);
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

  // Count personal memories (gate decision 4d) — use readDir: recall('') always returns []
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

      const vaultDir = `${services.homedir}/.chamba/vaults/${slug}`;
      const state = await readState(services.fs, vaultDir);

      let pending = '?';
      if (state) {
        try {
          const { snapshot } = await scanLocal({ fs: services.fs, hash: services.hash }, vaultDir);
          const pushEntries = planPush(toSyncState(state), snapshot);
          pending = String(pushEntries.length);
        } catch {
          pending = 'error';
        }
      }

      stdout('---');
      stdout(`slug:      ${slug}`);
      stdout(`server:    ${server}`);
      stdout(`role:      ${cred.role}`);
      stdout(`last sync: ${state?.lastSyncAt ?? 'never'}`);
      stdout(`pending:   ${pending} change(s)`);
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

  const vaultDir = `${services.homedir}/.chamba/vaults/${slug}`;

  // Remove only the credential — files stay intact (AC12)
  await creds.remove(found.server, slug);

  stdout(`Credencial eliminada para "${slug}".`);
  stdout(`Los archivos del vault siguen en: ${vaultDir}`);
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
      stderr('Usage: vault <subcommand> [args]\n' + 'Subcommands: join, sync, status, leave');
      exit(1);
    }
  }
}
