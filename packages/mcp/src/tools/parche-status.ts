/**
 * tools/parche-status.ts — chamba_parche_status MCP tool.
 * Shows status for all parche group vaults: server, slug, role, last sync,
 * pending changes, path. The token is never returned.
 */

import {
  CredentialsStore,
  joinFirstHint,
  joinPath,
  linkDirPlaceholderHint,
  MEMORY_DIR,
  planPush,
  readState,
  resolveVaultDir,
  scanLocal,
  toSyncState,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_parche_status';

const DESCRIPTION =
  'Show status for all parche group vaults: server, slug, role, last sync, ' +
  'pending changes, and vault path. Does not return the token.';

export function registerParcheStatus(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Parche status',
      description: DESCRIPTION,
      inputSchema: {},
    },
    async (_args) => {
      const creds = new CredentialsStore(services.fs, services.homedir);
      const allSlugs = await creds.listSlugs();

      if (allSlugs.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No parche vaults found. Use \`${joinFirstHint()}\` first.`,
            },
          ],
        };
      }

      // Count personal memories (gate decision 4: vault join / status warns about them).
      // Use readDir rather than recall('') — recall('') always returns [] (empty keywords).
      let personalMemoryCount = 0;
      try {
        const personalMemDir = joinPath(services.cwd, MEMORY_DIR);
        const entries = await services.fs.readDir(personalMemDir);
        personalMemoryCount = entries.filter(
          (e) => e.isFile && e.name.toLowerCase().endsWith('.md'),
        ).length;
      } catch {
        // Ignore if no personal memories directory exists
      }

      const rows: string[] = [];
      const structured: Array<Record<string, unknown>> = [];

      for (const { server: srv, slug: sl } of allSlugs) {
        try {
          const cred = await creds.get(srv, sl);
          if (!cred) continue;

          const vaultDir = resolveVaultDir(cred, services.homedir, sl);

          // PARCHE-009: check dir existence
          const dirExists = await services.fs.exists(vaultDir);
          const state = dirExists ? await readState(services.fs, vaultDir) : null;

          let pending = '?';
          if (!dirExists) {
            pending = `[carpeta ya no existe — ${linkDirPlaceholderHint(sl)}]`;
          } else if (state?.pendingAdoption === true) {
            pending = 'pendiente de confirmar';
          } else if (state) {
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

          const lastSync = state?.lastSyncAt ?? 'never';
          const adoptionNote = state?.pendingAdoption === true ? ' [pendiente de confirmar]' : '';
          const line = [
            `slug:      ${sl}`,
            `server:    ${srv}`,
            `role:      ${cred.role}`,
            `last sync: ${lastSync}${adoptionNote}`,
            `pending:   ${pending}${dirExists ? ' change(s)' : ''}`,
            `path:      ${vaultDir}`,
          ].join('\n');

          rows.push(line);
          structured.push({
            slug: sl,
            server: srv,
            role: cred.role,
            lastSyncAt: lastSync,
            pendingChanges: pending,
            vaultDir,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          rows.push(`${sl}: error — ${msg}`);
        }
      }

      const personalNote =
        personalMemoryCount > 0
          ? `\n\n⚠ ${personalMemoryCount} memoria(s) personal(es) en ${services.cwd}/.chamba/memory/ — siguen siendo privadas y no se sincronizan.`
          : '';

      logger.info({ tool: TOOL_NAME, vaults: allSlugs.length }, 'parche status');

      return {
        content: [{ type: 'text' as const, text: rows.join('\n\n') + personalNote }],
        structuredContent: { vaults: structured, personalMemoryCount } as Record<string, unknown>,
      };
    },
  );
}
