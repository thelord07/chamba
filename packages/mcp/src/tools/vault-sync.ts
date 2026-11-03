/**
 * tools/vault-sync.ts — chamba_vault_sync MCP tool.
 * Syncs one or all parche vaults with the remote server.
 */

import {
  CredentialsStore,
  joinFirstHint,
  linkDirPlaceholderHint,
  linkHint,
  readState,
  resolveVaultDir,
  syncOnce,
  VaultReindexer,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { describeError } from '../fatal.js';
import { formatSyncOutput } from '../parche/binding-ops.js';
import { withVaultLock } from '../parche/mutex.js';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_vault_sync';

const DESCRIPTION =
  'Sync one or all parche group vaults with the remote server. ' +
  'Without a slug, syncs every vault that has a credential.';

export function registerVaultSync(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Vault sync',
      description: DESCRIPTION,
      inputSchema: {
        slug: z.string().optional().describe('Vault slug to sync. Omit to sync all vaults.'),
      },
    },
    async ({ slug }) => {
      const creds = new CredentialsStore(services.fs, services.homedir);
      const allSlugs = await creds.listSlugs();

      const targets = slug ? allSlugs.filter((s) => s.slug === slug) : allSlugs;

      if (targets.length === 0) {
        const msg = slug
          ? `No credential found for vault "${slug}".`
          : `No parche credentials found. Use \`${joinFirstHint()}\` first.`;
        return { content: [{ type: 'text' as const, text: msg }] };
      }

      const results: string[] = [];
      const resultDetails: Array<Record<string, unknown>> = [];
      let anyError = false;

      for (const { server: srv, slug: sl } of targets) {
        try {
          const cred = await creds.get(srv, sl);
          if (!cred) {
            results.push(`${sl}: no credential`);
            anyError = true;
            continue;
          }

          const vaultDir = resolveVaultDir(cred, services.homedir, sl);

          // PARCHE-009: check if vault dir exists
          const dirExists = await services.fs.exists(vaultDir);
          if (!dirExists) {
            results.push(
              `${sl}: la carpeta "${vaultDir}" ya no existe — usa \`${linkDirPlaceholderHint(sl)}\``,
            );
            anyError = true;
            continue;
          }

          const state = await readState(services.fs, vaultDir);
          if (!state) {
            results.push(`${sl}: no state.json — run \`${joinFirstHint()}\` first`);
            anyError = true;
            continue;
          }

          // PARCHE-009: block if pending adoption
          if (state.pendingAdoption === true) {
            results.push(
              `${sl}: pendiente de confirmar — corre \`${linkHint(sl, vaultDir, { yes: true })}\``,
            );
            anyError = true;
            continue;
          }

          // Per-vault mutex: prevent two concurrent syncs within the same process.
          // Uses 'wait' so the explicit sync tool always completes, never skips.
          const mutexKey = `${srv}|${sl}`;
          const lockResult = await withVaultLock(
            services.vaultMutex,
            mutexKey,
            { onBusy: 'wait', logger, label: sl },
            () =>
              syncOnce(
                {
                  fs: services.fs,
                  http: services.http,
                  hash: services.hash,
                  clock: services.clock,
                },
                {
                  vaultDir,
                  server: srv,
                  slug: sl,
                  token: cred.token,
                  localAuthor: cred.user.name,
                  device: cred.device.label,
                  platform: services.platform,
                },
              ),
          );

          if (lockResult.skipped || lockResult.result === undefined) {
            results.push(`${sl}: skipped (another sync is already running)`);
            continue;
          }
          const summary = lockResult.result;

          logger.info({ tool: TOOL_NAME, slug: sl, ...summary }, 'parche: synced');
          results.push(
            `${sl}: pushed ${summary.pushed}, pulled ${summary.pulled}, conflicts ${summary.conflicts.length}`,
          );
          for (const c of summary.conflicts) {
            results.push(`  conflict: ${c.path} → copy saved as ${c.copyPath}`);
          }
          if (summary.movedToTrash.length > 0) {
            results.push(`  moved to trash: ${summary.movedToTrash.join(', ')}`);
          }
          // CHAMBA-015 D2.3
          for (const p of summary.skippedInvalidNames ?? []) {
            results.push(
              `  ⚠ No se puede crear '${p}' en Windows. ` +
                `Pídele a alguien en macOS/Linux que lo renombre; mientras tanto no se sincroniza en esta máquina.`,
            );
          }
          // CHAMBA-015 D2.4
          for (const p of summary.windowsIncompatibleNames ?? []) {
            results.push(`  ⚠ este nombre no se va a sincronizar en Windows: '${p}'`);
          }
          if (summary.errors.length > 0) {
            results.push(`  errors: ${summary.errors.join('; ')}`);
            anyError = true;
          }
          // CHAMBA-016: derived conflict summary line
          if ((summary.derivedConflictsResolved ?? []).length > 0) {
            const n = (summary.derivedConflictsResolved ?? []).length;
            results.push(
              `  ${n} archivos generados en conflicto: se aceptó la versión remota y se regeneran`,
            );
          }
          // CHAMBA-016: reindex after pull if needed (full, no deadline for explicit sync tool)
          if (summary.needsReindex) {
            try {
              const reindexReport = await new VaultReindexer(services.fs, vaultDir).reindex();
              if (reindexReport.archivosEscritos.length > 0) {
                results.push(
                  `  reindex: ${reindexReport.archivosEscritos.length} archivo(s) generado(s)`,
                );
              }
            } catch (reindexErr) {
              results.push(
                `  ⚠ reindex falló: ${reindexErr instanceof Error ? reindexErr.message : String(reindexErr)}`,
              );
            }
          }
          const syncOut = formatSyncOutput(summary);
          resultDetails.push({ slug: sl, ...syncOut });
        } catch (err) {
          const msg = describeError(err, { slug: sl });
          logger.warn({ tool: TOOL_NAME, slug: sl, err: msg }, 'parche: sync failed');
          results.push(`${sl}: error — ${msg}`);
          anyError = true;
          resultDetails.push({ slug: sl, error: msg });
        }
      }

      return {
        content: [{ type: 'text' as const, text: results.join('\n') }],
        structuredContent: { results: resultDetails, anyError } as Record<string, unknown>,
        ...(anyError ? { isError: true } : {}),
      };
    },
  );
}
