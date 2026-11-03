import { ObsidianDetector, VAULT_PLANS_DIR, VaultWriter } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { readGitRemote } from '../git-remote.js';
import { resolveActiveParcheVaultFull } from '../parche/active-vault.js';
import { maybeAutoSync } from '../parche/autosync.js';
import { obsidianSearchRoots, type Services } from '../services.js';

const TOOL_NAME = 'chamba_save_plan';

const NO_VAULT_ERROR =
  'No Obsidian vault configured. Set CHAMBA_OBSIDIAN_VAULT_PATH or run chamba_workspace_init to bootstrap one';

const DESCRIPTION =
  'Guarda un plan en el vault de Obsidian bajo `plans/[<owner-repo>/]<fecha>-<slug>.md`. ' +
  'Una sola nota puede tener varios temas (1-5); nunca crees notas separadas por tema. ' +
  'Lo desconocido va como propuesta, no lo inventes. ' +
  'Devuelve la ruta guardada, advertencias, temas aplicados/propuestos, árbol compacto y 5 nodos más cercanos.';

/** Format the extended knowledge-network response lines (shared with summarize). */
function formatKnowledgeResponse(
  prefix: string,
  notePath: string,
  result: Awaited<ReturnType<InstanceType<typeof VaultWriter>['write']>>,
  syncWarning: string | undefined,
): string {
  const lines: string[] = [];

  lines.push(`${prefix} ${notePath}`);

  if (syncWarning) {
    lines.push('');
    lines.push(`⚠ ${syncWarning}`);
  }

  if (result.warnings.length > 0) {
    lines.push('');
    lines.push('⚠ Advertencias:');
    for (const w of result.warnings) {
      lines.push(`- ${w}`);
    }
  }

  lines.push('');
  lines.push(
    `Temas aplicados: ${result.temasAplicados.length > 0 ? result.temasAplicados.join(', ') : 'ninguno'}`,
  );
  lines.push(
    `Temas propuestos: ${result.temasPropuestos.length > 0 ? result.temasPropuestos.join(', ') : 'ninguno'}`,
  );

  if (result.arbol) {
    lines.push('');
    lines.push('Red de conocimiento:');
    lines.push(result.arbol);
  }

  if (result.cercanos.length > 0) {
    lines.push('');
    lines.push('5 nodos más cercanos:');
    for (const c of result.cercanos) {
      lines.push(`- ${c.path} (${c.score})`);
    }
  }

  if (result.related.length > 0) {
    lines.push('');
    lines.push(`Notas relacionadas: ${result.related.join(', ')}`);
  }

  return lines.join('\n');
}

/** Register `chamba_save_plan`: write a plan to the vault's `plans/` folder. */
export function registerSavePlan(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Save plan',
      description: DESCRIPTION,
      inputSchema: {
        title: z.string().describe('Plan title — usually the ticket id or task name.'),
        content: z.string().describe('The plan markdown (goal, acceptance criteria, subtasks…).'),
        projectSlug: z.string().optional().describe('Optional slug for the filename.'),
        summary: z.string().max(200).optional().describe('Resumen de 1 línea (≤200 chars).'),
        temas: z
          .array(z.string())
          .min(1)
          .max(5)
          .optional()
          .describe('1 a 5 temas del vocabulario.'),
        keywords: z
          .array(z.string().max(40))
          .max(10)
          .optional()
          .describe('Palabras clave (≤10, cada ≤40 chars).'),
        aliases: z.array(z.string()).optional().describe('Aliases Obsidian de la nota.'),
        workItem: z
          .string()
          .optional()
          .describe('ID del work item (hu-..., cu-...) que enlaza plan ↔ resumen.'),
        related: z
          .array(z.string())
          .optional()
          .describe('Rutas relativas al vault de notas relacionadas.'),
      },
    },
    async ({
      title,
      content,
      projectSlug,
      summary,
      temas,
      keywords,
      aliases,
      workItem,
      related,
    }) => {
      // O2: full discriminated resolution
      const vaultResult = await resolveActiveParcheVaultFull(services);

      // O2: bound-unsyncable
      if (vaultResult.kind === 'bound-unsyncable') {
        if (!vaultResult.dirExists) {
          // For invalid-binding/error, vaultDir is '' — use hint directly
          const errText =
            vaultResult.reason === 'invalid-binding' || vaultResult.reason === 'error'
              ? `No se pudo guardar el plan: ${vaultResult.hint}`
              : `No se pudo guardar el plan: la carpeta del parche (${vaultResult.vaultDir}) no existe. ${vaultResult.hint}`;
          return {
            isError: true,
            content: [{ type: 'text' as const, text: errText }],
          };
        }
        // Dir exists: write there but skip sync
      }

      const parcheVault = vaultResult.kind === 'ok' ? vaultResult.vault : null;

      // R2/§4: with a parche vault, write there (not the Obsidian detector)
      let vaultPath: string | undefined;
      if (vaultResult.kind === 'bound-unsyncable' && vaultResult.dirExists) {
        vaultPath = vaultResult.vaultDir;
      } else if (parcheVault) {
        vaultPath = parcheVault.vaultDir;
      } else if (vaultResult.kind !== 'bound-unsyncable') {
        const detection = await new ObsidianDetector(services.fs).detect({
          explicitPath: services.obsidianVaultPath,
          searchRoots: obsidianSearchRoots(services),
        });
        if (detection.found) vaultPath = detection.path;
      }

      if (!vaultPath) {
        logger.info({ tool: TOOL_NAME }, 'no vault configured');
        return { isError: true, content: [{ type: 'text', text: NO_VAULT_ERROR }] };
      }

      const writer = new VaultWriter(services.fs, services.clock);
      const result = await writer.write({
        vaultPath,
        title,
        content,
        projectSlug,
        subdir: VAULT_PLANS_DIR,
        tags: ['chamba', 'plan'],
        summary,
        temas,
        keywords,
        aliases,
        workItem,
        related,
        type: 'plan',
        projectRemoteUrl: await readGitRemote(services.process, services.cwd),
      });
      logger.info({ tool: TOOL_NAME, notePath: result.notePath }, 'plan saved to vault');

      // PARCHE-011: push sync after writing (only with parche vault and autoSync enabled)
      // O2: if bound-unsyncable with dir existing, show hint
      let syncWarning: string | undefined;
      if (vaultResult.kind === 'bound-unsyncable') {
        syncWarning = `parche no sincronizable: ${vaultResult.hint}`;
      } else if (parcheVault?.autoSync.enabled) {
        const syncResult = await maybeAutoSync(services, logger, parcheVault, 'push');
        syncWarning = syncResult.warning;
      }

      const text = formatKnowledgeResponse('Saved plan to', result.notePath, result, syncWarning);

      return { content: [{ type: 'text', text }] };
    },
  );
}
