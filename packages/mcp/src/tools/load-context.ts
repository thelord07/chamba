import { ContextBuilder, ObsidianDetector, WorkspaceScanner } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { resolveActiveParcheVaultFull } from '../parche/active-vault.js';
import { maybeAutoSync } from '../parche/autosync.js';
import { obsidianSearchRoots, type Services } from '../services.js';

const TOOL_NAME = 'chamba_load_context';

const DESCRIPTION =
  'Load context for a task: a summary of the workspace plus, when an Obsidian ' +
  'vault is available, a relevance map of topics and notes (mapa mode) or the ' +
  'most relevant notes (keyword search). ' +
  'Returns a markdown block the model can reason over before planning. ' +
  'When mapa is present in structuredContent, use chamba_vault_navigate on each ' +
  'nodo.ruta to explore the knowledge network.';

const LOAD_CONTEXT_MAX_TOKENS = 2000;

const MAPA_OUTPUT_SCHEMA = z.object({
  mapa: z
    .object({
      nodos: z.array(
        z.object({
          ruta: z.string(),
          descripcion: z.string(),
          conteoSubarbol: z.number(),
          notas: z.array(
            z.object({
              titulo: z.string(),
              ruta: z.string(),
              type: z.string(),
              summary: z.string().optional(),
              keywords: z.array(z.string()),
              workItem: z.string().optional(),
              date: z.string().optional(),
              score: z.number(),
            }),
          ),
        }),
      ),
      workItems: z.array(
        z.object({
          id: z.string(),
          notas: z.array(
            z.object({
              titulo: z.string(),
              ruta: z.string(),
              type: z.string(),
              summary: z.string().optional(),
              keywords: z.array(z.string()),
              workItem: z.string().optional(),
              date: z.string().optional(),
              score: z.number(),
            }),
          ),
        }),
      ),
      recortado: z.boolean(),
      reglasRecortadas: z.boolean().optional(),
    })
    .optional(),
});

/** Register `chamba_load_context`: workspace summary + relevant vault notes. */
export function registerLoadContext(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Load context',
      description: DESCRIPTION,
      inputSchema: {
        task: z.string().describe('The task you are about to work on.'),
        includeObsidian: z
          .boolean()
          .optional()
          .describe('Search the Obsidian vault for relevant notes (default true).'),
        includeRules: z
          .boolean()
          .optional()
          .describe("Include each repo's coding rules across editors (default true)."),
      },
      outputSchema: MAPA_OUTPUT_SCHEMA,
    },
    async ({ task, includeObsidian, includeRules }) => {
      // O2: full discriminated resolution
      const vaultResult = await resolveActiveParcheVaultFull(services);

      // O2: bound-unsyncable → skip notes, include warning in context
      let syncWarning: string | undefined;
      if (vaultResult.kind === 'bound-unsyncable') {
        syncWarning = `parche no sincronizable: ${vaultResult.hint}`;
      }

      const parcheVault = vaultResult.kind === 'ok' ? vaultResult.vault : null;

      // C5: pull auto-sync before reading if active vault is a parche vault
      if (parcheVault?.autoSync.enabled) {
        const syncResult = await maybeAutoSync(services, logger, parcheVault, 'pull');
        syncWarning = syncResult.warning;
      }

      const workspace = await new WorkspaceScanner(services.fs).scan(services.cwd);

      let vaultPath: string | undefined;
      if (includeObsidian !== false) {
        if (vaultResult.kind === 'bound-unsyncable' && vaultResult.dirExists) {
          // O2: dir exists but can't sync — still read from it
          vaultPath = vaultResult.vaultDir;
        } else if (parcheVault) {
          // R2: when there's a parche vault, use its vaultDir directly (no Obsidian detection)
          vaultPath = parcheVault.vaultDir;
        } else if (vaultResult.kind !== 'bound-unsyncable') {
          // No binding → use Obsidian detector
          const detection = await new ObsidianDetector(services.fs).detect({
            explicitPath: services.obsidianVaultPath,
            searchRoots: obsidianSearchRoots(services),
          });
          if (detection.found) vaultPath = detection.path;
        }
      }

      const built = await new ContextBuilder(services.fs).build({
        workspace,
        task,
        vaultPath,
        includeRules,
        maxTokens: LOAD_CONTEXT_MAX_TOKENS,
      });
      logger.info(
        { tool: TOOL_NAME, vault: vaultPath ?? null, notes: built.relevantNotes.length },
        'context built',
      );

      const text = syncWarning ? `${built.context}\n\n⚠ ${syncWarning}` : built.context;

      if (built.mapa) {
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: { mapa: built.mapa },
        };
      }

      return { content: [{ type: 'text' as const, text }], structuredContent: { mapa: undefined } };
    },
  );
}
