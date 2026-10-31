/**
 * tools/vault-resync.ts — chamba_vault_resync MCP tool.
 *
 * PARCHE-010 O3: Reset state in-place and re-adopt a vault (re-download from server).
 * Useful when local state is corrupted or when a fresh pull is needed.
 * Does NOT change the vault directory or credentials.
 * If the vault has existing files, returns needsConfirmation unless confirmUpload:true.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  checkAdoptionGate,
  finalizeAdoption,
  formatSyncOutput,
  gateStructuredDetails,
  redactSecrets,
  resyncPrepare,
} from '../parche/binding-ops.js';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_vault_resync';

const DESCRIPTION =
  'Reset a vault state in-place and re-adopt it (re-download from the server). ' +
  'Useful when local state is corrupted. ' +
  'If the vault has existing files, returns needsConfirmation unless confirmUpload:true. ' +
  'Does not change the vault directory or credentials.';

export function registerVaultResync(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Vault resync',
      description: DESCRIPTION,
      inputSchema: {
        slug: z.string().describe('The vault slug to resync.'),
        confirmUpload: z
          .boolean()
          .optional()
          .describe(
            'Set to true to confirm uploading existing files. ' +
              'Required when the vault has files and you want to proceed.',
          ),
      },
    },
    async ({ slug, confirmUpload }) => {
      try {
        const prep = await resyncPrepare(services, { slug });

        if (prep.kind === 'error') {
          return { isError: true, content: [{ type: 'text' as const, text: prep.message }] };
        }

        const { server: srv, cred, vaultDir, summary } = prep;

        // Adoption gate
        const gate = checkAdoptionGate(summary, confirmUpload);
        if (gate.kind === 'needs-confirmation') {
          const gateDetails = gateStructuredDetails(gate);
          logger.info(
            { tool: TOOL_NAME, slug, fileCount: gate.fileCount },
            'parche: resync needs confirmation',
          );
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `El vault "${vaultDir}" tiene ${gate.fileCount} archivo(s) sincronizable(s).\n` +
                  `Archivos ignorados: ${gate.ignoredCount}\n` +
                  (gate.sample.length > 0
                    ? `Muestra (primeros ${gate.sample.length}):\n${gate.sample.map((p) => `  - ${p}`).join('\n')}\n`
                    : '') +
                  `\nPara confirmar la re-sincronización, vuelve a llamar con el mismo slug y confirmUpload: true.`,
              },
            ],
            structuredContent: {
              needsConfirmation: true,
              slug,
              vaultDir,
              ...gateDetails,
            } as Record<string, unknown>,
          };
        }

        // Confirmed (or empty vault): finalize
        const syncResult = await finalizeAdoption(services, {
          server: srv,
          slug,
          vaultDir,
          cred,
        });

        logger.info({ tool: TOOL_NAME, slug, vault: vaultDir }, 'parche: resynced');

        const syncOut = formatSyncOutput(syncResult);
        const text = [
          `Vault "${slug}" re-sincronizado en "${vaultDir}".`,
          `Sync: pushed ${syncOut.pushed}, pulled ${syncOut.pulled}, conflicts ${syncResult.conflicts.length}`,
        ].join('\n');

        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: {
            slug,
            vaultDir,
            ...syncOut,
          } as Record<string, unknown>,
        };
      } catch (err) {
        const msg = redactSecrets(err instanceof Error ? err.message : String(err));
        logger.warn({ tool: TOOL_NAME, slug, err: msg }, 'parche: resync failed');
        return { isError: true, content: [{ type: 'text' as const, text: msg }] };
      }
    },
  );
}
