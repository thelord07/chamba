import { ObsidianDetector, VaultWriter } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { readGitRemote } from '../git-remote.js';
import { resolveActiveParcheVaultFull } from '../parche/active-vault.js';
import { maybeAutoSync } from '../parche/autosync.js';
import { obsidianSearchRoots, type Services } from '../services.js';

const TOOL_NAME = 'chamba_summarize_to_vault';

const NO_VAULT_ERROR =
  'No Obsidian vault configured. Set CHAMBA_OBSIDIAN_VAULT_PATH or use the obsidian-mcp server';

const DESCRIPTION =
  'Escribe una nota de resumen estructurada en el vault de Obsidian. ' +
  'Una sola nota puede tener varios temas (1-5); nunca crees notas separadas por tema. ' +
  'Lo desconocido va como propuesta, no lo inventes. ' +
  'Agrupa notas bajo `proyectos/[<owner-repo>/]<fecha>-<slug>.md` con frontmatter YAML válido. ' +
  'Devuelve la ruta escrita, advertencias, temas aplicados/propuestos, árbol compacto y 5 nodos más cercanos.';

/** Format the extended knowledge-network response lines. */
function formatKnowledgeResponse(
  notePath: string,
  result: Awaited<ReturnType<InstanceType<typeof VaultWriter>['write']>>,
  syncWarning: string | undefined,
): string {
  const lines: string[] = [];

  // First line: path
  lines.push(`Wrote note to ${notePath}`);

  // Sync warning
  if (syncWarning) {
    lines.push('');
    lines.push(`⚠ ${syncWarning}`);
  }

  // Warnings from knowledge resolution
  if (result.warnings.length > 0) {
    lines.push('');
    lines.push('⚠ Advertencias:');
    for (const w of result.warnings) {
      lines.push(`- ${w}`);
    }
  }

  // Temas
  lines.push('');
  lines.push(
    `Temas aplicados: ${result.temasAplicados.length > 0 ? result.temasAplicados.join(', ') : 'ninguno'}`,
  );
  lines.push(
    `Temas propuestos: ${result.temasPropuestos.length > 0 ? result.temasPropuestos.join(', ') : 'ninguno'}`,
  );

  // Compact tree
  if (result.arbol) {
    lines.push('');
    lines.push('Red de conocimiento:');
    lines.push(result.arbol);
  }

  // 5 closest nodes
  if (result.cercanos.length > 0) {
    lines.push('');
    lines.push('5 nodos más cercanos:');
    for (const c of result.cercanos) {
      lines.push(`- ${c.path} (${c.score})`);
    }
  }

  // Related notes
  if (result.related.length > 0) {
    lines.push('');
    lines.push(`Notas relacionadas: ${result.related.join(', ')}`);
  }

  return lines.join('\n');
}

/** Register `chamba_summarize_to_vault`: write a note to the vault. */
export function registerSummarizeToVault(
  server: McpServer,
  logger: Logger,
  services: Services,
): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Summarize to vault',
      description: DESCRIPTION,
      inputSchema: {
        title: z.string().describe('Note title.'),
        content: z.string().describe('Markdown body (summary, plan, decisions, next steps).'),
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
        type: z
          .enum(['resumen', 'nota', 'plan'])
          .optional()
          .default('resumen')
          .describe('Tipo de nota (default: resumen).'),
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
      type,
    }) => {
      // O2: full discriminated resolution — never fall through from a binding
      const vaultResult = await resolveActiveParcheVaultFull(services);

      // O2: bound-unsyncable
      if (vaultResult.kind === 'bound-unsyncable') {
        if (!vaultResult.dirExists) {
          // For invalid-binding/error, vaultDir is '' — use hint directly
          const errText =
            vaultResult.reason === 'invalid-binding' || vaultResult.reason === 'error'
              ? `No se pudo escribir la nota: ${vaultResult.hint}`
              : `No se pudo escribir la nota: la carpeta del parche (${vaultResult.vaultDir}) no existe. ${vaultResult.hint}`;
          return {
            isError: true,
            content: [{ type: 'text' as const, text: errText }],
          };
        }
        // Dir exists: write there but skip auto-sync
      }

      const parcheVault = vaultResult.kind === 'ok' ? vaultResult.vault : null;

      // R2: with a parche vault, write to its vaultDir (not the Obsidian detector)
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
        return { isError: true, content: [{ type: 'text' as const, text: NO_VAULT_ERROR }] };
      }

      const writer = new VaultWriter(services.fs, services.clock);
      const result = await writer.write({
        vaultPath,
        title,
        content,
        projectSlug,
        summary,
        temas,
        keywords,
        aliases,
        workItem,
        related,
        type,
        projectRemoteUrl: await readGitRemote(services.process, services.cwd),
      });
      logger.info({ tool: TOOL_NAME, notePath: result.notePath }, 'note written to vault');

      // C5: push auto-sync after writing if active vault is a parche vault (and autoSync enabled)
      // O2: if bound-unsyncable with dir existing, show hint instead
      let syncWarning: string | undefined;
      if (vaultResult.kind === 'bound-unsyncable') {
        syncWarning = `parche no sincronizable: ${vaultResult.hint}`;
      } else if (parcheVault?.autoSync.enabled) {
        const syncResult = await maybeAutoSync(services, logger, parcheVault, 'push');
        syncWarning = syncResult.warning;
      }

      const text = formatKnowledgeResponse(result.notePath, result, syncWarning);

      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
