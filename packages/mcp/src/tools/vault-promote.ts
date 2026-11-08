/**
 * tools/vault-promote.ts — chamba_vault_promote MCP tool (CHAMBA-021 S12).
 *
 * Promotes one or more NOTES from `estado: propuesto` to `estado: canonico`.
 * This is NOT `chamba_vault_topics action:'promote'`, which promotes a
 * *proposed topic* to the vocabulary — see both tool descriptions.
 *
 * `dryRun: true` by default (several paths = a bulk action), same pattern as
 * `chamba_vault_classify` and `chamba_vault_topics`.
 */
import {
  ObsidianDetector,
  promoteNotesApply,
  promoteNotesPlan,
  VaultReindexer,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { resolveActiveParcheVaultFull } from '../parche/active-vault.js';
import { maybeAutoSync } from '../parche/autosync.js';
import { obsidianSearchRoots, type Services } from '../services.js';

const TOOL_NAME = 'chamba_vault_promote';

const DESCRIPTION =
  'Promueve una o más NOTAS de `estado: propuesto` a `estado: canonico` (marca que un ' +
  "humano ya las revisó). No confundir con `chamba_vault_topics action:'promote'`, que " +
  'promueve un TEMA propuesto al vocabulario — esta tool nunca toca temas/VOCABULARIO.md. ' +
  'IMPORTANTE: dryRun:true por defecto — muestra el diff sin escribir. La confirmación ' +
  'explícita del usuario es obligatoria antes de llamar con dryRun:false.';

const NO_VAULT_ERROR =
  'No Obsidian vault configured. Set CHAMBA_OBSIDIAN_VAULT_PATH or use the obsidian-mcp server';

export function registerVaultPromote(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Vault promote (note)',
      description: DESCRIPTION,
      inputSchema: {
        paths: z
          .array(z.string())
          .min(1)
          .describe('Rutas relativas al vault de las notas a promover.'),
        dryRun: z
          .boolean()
          .optional()
          .describe('Si true (default), solo muestra el diff sin escribir.'),
      },
    },
    async ({ paths, dryRun }) => {
      const vaultResult = await resolveActiveParcheVaultFull(services);
      if (vaultResult.kind === 'bound-unsyncable' && !vaultResult.dirExists) {
        return {
          isError: true,
          content: [
            { type: 'text' as const, text: `No hay vault disponible: ${vaultResult.hint}` },
          ],
        };
      }

      let vaultPath: string | undefined;
      if (vaultResult.kind === 'bound-unsyncable' && vaultResult.dirExists) {
        vaultPath = vaultResult.vaultDir;
      } else if (vaultResult.kind === 'ok') {
        vaultPath = vaultResult.vault.vaultDir;
      } else {
        const detection = await new ObsidianDetector(services.fs).detect({
          explicitPath: services.obsidianVaultPath,
          searchRoots: obsidianSearchRoots(services),
        });
        if (detection.found) vaultPath = detection.path;
      }

      if (!vaultPath) {
        logger.info({ tool: TOOL_NAME }, 'no vault configured');
        return { isError: true, content: [{ type: 'text' as const, text: NO_VAULT_ERROR }] };
      }

      const effectiveDryRun = dryRun !== false;
      logger.info({ tool: TOOL_NAME, paths, dryRun: effectiveDryRun }, 'vault-promote');

      if (effectiveDryRun) {
        const plan = await promoteNotesPlan(services.fs, vaultPath, paths);
        const lines = [
          `[dryRun] promote — ${plan.diffs.length} nota(s) a promover, ${plan.rejected.length} rechazada(s):`,
          '',
        ];
        for (const diff of plan.diffs) {
          lines.push(`### ${diff.path}`);
          lines.push('**Antes:**');
          lines.push('```yaml');
          lines.push(diff.before || '(sin frontmatter)');
          lines.push('```');
          lines.push('**Después:**');
          lines.push('```yaml');
          lines.push(diff.after || '(sin frontmatter)');
          lines.push('```');
          lines.push('');
        }
        for (const rej of plan.rejected) lines.push(`⚠ "${rej.path}": ${rej.reason}`);
        lines.push('');
        lines.push(
          'Llama de nuevo con dryRun:false para aplicar (requiere confirmación del usuario).',
        );
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      const result = await promoteNotesApply(services.fs, vaultPath, paths);

      const reindexer = new VaultReindexer(services.fs, vaultPath);
      await reindexer.reindex({ dryRun: false });

      let syncWarning: string | undefined;
      if (vaultResult.kind === 'ok' && vaultResult.vault.autoSync.enabled) {
        const syncResult = await maybeAutoSync(services, logger, vaultResult.vault, 'push');
        syncWarning = syncResult.warning;
      }

      const lines = [
        `promote: ${result.written.length} nota(s) promovida(s) a canónica(s), ${result.rejected.length} rechazada(s).`,
        '',
      ];
      for (const w of result.written) lines.push(`✓ ${w}`);
      for (const rej of result.rejected) lines.push(`⚠ "${rej.path}": ${rej.reason}`);
      if (syncWarning) lines.push('', `⚠ ${syncWarning}`);

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );
}
