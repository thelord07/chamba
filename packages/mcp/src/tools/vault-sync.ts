/**
 * tools/vault-sync.ts — chamba_vault_sync MCP tool.
 * Syncs one or all parche vaults with the remote server.
 */

import { CredentialsStore, readState, resolveVaultDir, syncOnce } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
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
          : 'No parche credentials found. Use vault join first.';
        return { content: [{ type: 'text' as const, text: msg }] };
      }

      const results: string[] = [];
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
              `${sl}: la carpeta "${vaultDir}" ya no existe — usa \`vault link ${sl} --dir <ruta>\``,
            );
            anyError = true;
            continue;
          }

          const state = await readState(services.fs, vaultDir);
          if (!state) {
            results.push(`${sl}: no state.json — run vault join first`);
            anyError = true;
            continue;
          }

          // PARCHE-009: block if pending adoption
          if (state.pendingAdoption === true) {
            results.push(
              `${sl}: pendiente de confirmar — corre \`vault link ${sl} --dir "${vaultDir}" --yes\``,
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
                },
              ),
          );

          if (lockResult.skipped || lockResult.result === undefined) {
            results.push(`${sl}: skipped (another sync is already running)`);
            continue;
          }
          const summary = lockResult.result;

          logger.info({ tool: TOOL_NAME, slug: sl, ...summary }, 'vault synced');
          results.push(
            `${sl}: pushed ${summary.pushed}, pulled ${summary.pulled}, conflicts ${summary.conflicts.length}`,
          );
          if (summary.errors.length > 0) {
            results.push(`  errors: ${summary.errors.join('; ')}`);
            anyError = true;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ tool: TOOL_NAME, slug: sl, err: msg }, 'vault sync failed');
          results.push(`${sl}: error — ${msg}`);
          anyError = true;
        }
      }

      return {
        content: [{ type: 'text' as const, text: results.join('\n') }],
        structuredContent: { results, anyError } as Record<string, unknown>,
        ...(anyError ? { isError: true } : {}),
      };
    },
  );
}
