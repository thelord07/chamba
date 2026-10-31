/**
 * tools/vault-link.ts — chamba_vault_link MCP tool.
 *
 * PARCHE-010: Re-link an existing vault credential to a new local directory.
 * Resets the sync state (pendingAdoption=true) and runs the adoption gate.
 * If the directory has files, returns needsConfirmation unless confirmUpload:true.
 * Does NOT move or delete the old directory.
 * The token is never returned.
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
  relinkPrepare,
  updateBindingVaultDirForSlug,
} from '../parche/binding-ops.js';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_vault_link';

const DESCRIPTION =
  'Re-link an existing parche vault credential to a new local directory. ' +
  'Resets the sync state and runs the adoption gate. ' +
  'If the directory has existing files, returns needsConfirmation unless confirmUpload:true. ' +
  'Does not move or delete the old directory. ' +
  'Note: to link inside a git repo, use the CLI with --allow-in-repo.';

export function registerVaultLink(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Vault link',
      description: DESCRIPTION,
      inputSchema: {
        slug: z.string().describe('The vault slug to re-link.'),
        dir: z.string().describe('Absolute local path for the vault directory. ~ is expanded.'),
        confirmUpload: z
          .boolean()
          .optional()
          .describe(
            'Set to true to confirm uploading existing files. ' +
              'Required when the vault has files and you want to proceed.',
          ),
      },
    },
    async ({ slug, dir, confirmUpload }) => {
      try {
        const prep = await relinkPrepare(services, {
          slug,
          dirInput: dir,
          allowInRepo: false, // D5: no allowInRepo in MCP tool
        });

        if (prep.kind === 'error') {
          return { isError: true, content: [{ type: 'text' as const, text: prep.message }] };
        }

        if (prep.kind === 'in-repo') {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text:
                  `La ruta "${dir}" está dentro de un repositorio git. ` +
                  `Usa la CLI con --allow-in-repo para permitirlo.`,
              },
            ],
          };
        }

        if (prep.kind === 'noop') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Vault "${slug}" ya está vinculado a "${prep.canonicalDir}"; nada que hacer.`,
              },
            ],
            structuredContent: { noop: true, slug, vaultDir: prep.canonicalDir } as Record<
              string,
              unknown
            >,
          };
        }

        // prep.kind === 'ready'
        const { server: srv, cred, oldDir, canonicalDir, summary } = prep;

        // Adoption gate
        const gate = checkAdoptionGate(summary, confirmUpload);
        if (gate.kind === 'needs-confirmation') {
          const gateDetails = gateStructuredDetails(gate);
          logger.info(
            { tool: TOOL_NAME, slug, fileCount: gate.fileCount },
            'parche: link needs confirmation',
          );
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `El vault "${canonicalDir}" tiene ${gate.fileCount} archivo(s) sincronizable(s).\n` +
                  `Archivos ignorados: ${gate.ignoredCount}\n` +
                  (gate.sample.length > 0
                    ? `Muestra (primeros ${gate.sample.length}):\n${gate.sample.map((p) => `  - ${p}`).join('\n')}\n`
                    : '') +
                  `\nPara confirmar la subida, vuelve a llamar con el mismo slug y dir, y confirmUpload: true.`,
              },
            ],
            structuredContent: {
              needsConfirmation: true,
              slug,
              vaultDir: canonicalDir,
              oldDir,
              ...gateDetails,
            } as Record<string, unknown>,
          };
        }

        // Confirmed (or empty vault): finalize
        const syncResult = await finalizeAdoption(services, {
          server: srv,
          slug,
          vaultDir: canonicalDir,
          cred,
        });

        logger.info({ tool: TOOL_NAME, slug, vault: canonicalDir }, 'parche: linked');

        // PARCHE-010: update parche.json binding(s) with new vaultDir (best-effort)
        let updatedBindings: string[] = [];
        try {
          updatedBindings = await updateBindingVaultDirForSlug(services, {
            slug,
            newVaultDir: canonicalDir,
          });
        } catch {
          // Best-effort
        }

        const syncOut = formatSyncOutput(syncResult);
        const textLines = [
          `Vault "${slug}" re-vinculado a "${canonicalDir}".`,
          oldDir !== canonicalDir ? `Ruta anterior: "${oldDir}" (sigue en disco intacta).` : null,
          `Sync: pushed ${syncOut.pushed}, pulled ${syncOut.pulled}, conflicts ${syncResult.conflicts.length}`,
          ...updatedBindings,
        ].filter(Boolean);

        return {
          content: [{ type: 'text' as const, text: textLines.join('\n') }],
          structuredContent: {
            slug,
            vaultDir: canonicalDir,
            oldDir,
            updatedBindings,
            ...syncOut,
          } as Record<string, unknown>,
        };
      } catch (err) {
        const msg = redactSecrets(err instanceof Error ? err.message : String(err));
        logger.warn({ tool: TOOL_NAME, slug, err: msg }, 'parche: link failed');
        return { isError: true, content: [{ type: 'text' as const, text: msg }] };
      }
    },
  );
}
