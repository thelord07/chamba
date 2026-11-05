/**
 * tools/vault-reindex.ts — chamba_vault_reindex MCP tool (CHAMBA-016 ola 3).
 *
 * Reconstruye los archivos derivados del vault: INDEX.md generados, hubs de temas, bases.
 *
 * O2: adoptManual con dryRun por defecto TRUE cuando se pasa adoptManual (muestra el plan);
 * dryRun:false solo tras confirmación del usuario (descripción lo dice); nunca automático.
 */
import { ObsidianDetector, VaultReindexer } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { resolveActiveParcheVaultFull } from '../parche/active-vault.js';
import { withVaultLock } from '../parche/mutex.js';
import { obsidianSearchRoots, type Services } from '../services.js';

const TOOL_NAME = 'chamba_vault_reindex';

const DESCRIPTION =
  'Reconstruye los archivos derivados del vault (INDEX.md generados, hubs de temas, bases). ' +
  'Sin adoptManual: corre reindex normal (dryRun:false por defecto). ' +
  'Con adoptManual: muestra el plan de adopción primero (dryRun:true por defecto) y ' +
  'solo adopta tras la confirmación explícita del usuario con dryRun:false. ' +
  'NUNCA automático. La adopción renombra INDEX.md manual a "INDEX (manual).md" y genera uno nuevo.';

const NO_VAULT_ERROR =
  'No Obsidian vault configured. Set CHAMBA_OBSIDIAN_VAULT_PATH or use the obsidian-mcp server';

function formatReport(report: Awaited<ReturnType<VaultReindexer['reindex']>>): string {
  const lines = [
    `Reindex completado:`,
    `  Notas escaneadas: ${report.notas}`,
    `  Temas en vocabulario: ${report.temas}`,
    `  Sin clasificar: ${report.sinClasificar}`,
    `  Propuestos: ${report.propuestos}`,
    `  Archivos escritos: ${report.archivosEscritos.length}`,
  ];

  if (report.archivosEscritos.length > 0) {
    for (const f of report.archivosEscritos) lines.push(`    ✓ ${f}`);
  }

  if (report.archivosEliminados && report.archivosEliminados.length > 0) {
    lines.push(`  Archivos eliminados (huérfanos): ${report.archivosEliminados.length}`);
    for (const f of report.archivosEliminados) lines.push(`    - ${f}`);
  }

  if (report.indicesManualesOmitidos.length > 0) {
    lines.push(`  INDEX.md manuales (no sobreescritos): ${report.indicesManualesOmitidos.length}`);
    for (const f of report.indicesManualesOmitidos) lines.push(`    - ${f}`);
  }

  if (report.adoptados && report.adoptados.length > 0) {
    lines.push(`  Adoptados: ${report.adoptados.length}`);
    for (const f of report.adoptados) lines.push(`    ✓ ${f}`);
  }

  if (report.renombrados && report.renombrados.length > 0) {
    for (const r of report.renombrados) lines.push(`  Renombrado: ${r.from} → ${r.to}`);
  }

  if (report.erroresVocabulario.length > 0) {
    lines.push(`  ⚠ Errores de vocabulario: ${report.erroresVocabulario.length}`);
    for (const e of report.erroresVocabulario) {
      lines.push(`    - ${e.message}`);
    }
  }

  if (report.sugerencias.length > 0) {
    lines.push(`  Sugerencias: ${report.sugerencias.length}`);
    for (const s of report.sugerencias) {
      lines.push(
        `    - ${s.proposed}${s.readyToPromote ? ' (listo para promover)' : ''}${s.maybeSameAs && s.maybeSameAs.length > 0 ? ` ¿quizás: ${s.maybeSameAs.join(', ')}?` : ''}`,
      );
    }
  }

  if (report.incompleto) {
    lines.push('  ⚠ Incompleto: se alcanzó el límite de tiempo.');
  }

  return lines.join('\n');
}

/** Register `chamba_vault_reindex`. */
export function registerVaultReindex(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Vault reindex',
      description: DESCRIPTION,
      inputSchema: {
        dryRun: z
          .boolean()
          .optional()
          .describe(
            'Si true, calcula sin escribir. Default: false (salvo si se pasa adoptManual, donde default es true).',
          ),
        adoptManual: z
          .array(z.string())
          .optional()
          .describe(
            'Carpetas cuyo INDEX.md manual se adoptará. Con adoptManual, dryRun es true por defecto. ' +
              'Requiere confirmación explícita del usuario antes de pasar dryRun:false.',
          ),
      },
    },
    async ({ dryRun, adoptManual }) => {
      // O2: if adoptManual passed and dryRun not explicitly set → default dryRun to true
      const hasAdoptManual = (adoptManual?.length ?? 0) > 0;
      const effectiveDryRun = dryRun ?? hasAdoptManual;

      // Resolve vault
      const vaultResult = await resolveActiveParcheVaultFull(services);
      if (vaultResult.kind === 'bound-unsyncable' && !vaultResult.dirExists) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `No hay vault disponible: ${vaultResult.hint}`,
            },
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

      logger.info(
        { tool: TOOL_NAME, vaultPath, dryRun: effectiveDryRun, hasAdoptManual },
        'vault-reindex',
      );

      // Acquire the shared reindex lock (same key used by vault-navigate + autosync).
      // dryRun does not write, so we skip the lock for dry runs.
      let vaultRealPath = vaultPath;
      try {
        vaultRealPath = await services.fs.realpath(vaultPath);
      } catch {
        /* fall back to raw path */
      }
      const reindexLockKey = `reindex|${vaultRealPath}`;

      if (!effectiveDryRun) {
        const lockResult = await withVaultLock(
          services.vaultMutex,
          reindexLockKey,
          { onBusy: 'skip', logger, label: 'vault-reindex' },
          async () => {
            const r = await new VaultReindexer(services.fs, vaultPath).reindex({
              dryRun: false,
              adoptManual: adoptManual ?? [],
            });
            return r;
          },
        );

        if (lockResult.skipped) {
          return {
            content: [
              {
                type: 'text' as const,
                text: 'Otro reindex en curso para este vault; reintenta en unos segundos.',
              },
            ],
          };
        }

        const report = lockResult.result;
        if (!report) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: 'Reindex falló inesperadamente.' }],
          };
        }

        const reportText = formatReport(report);

        if (hasAdoptManual) {
          return {
            content: [{ type: 'text' as const, text: reportText }],
          };
        }

        return { content: [{ type: 'text' as const, text: reportText }] };
      }

      // dryRun path: no lock needed
      const reindexer = new VaultReindexer(services.fs, vaultPath);
      const report = await reindexer.reindex({
        dryRun: effectiveDryRun,
        adoptManual: adoptManual ?? [],
      });

      const reportText = formatReport(report);

      if (effectiveDryRun && hasAdoptManual) {
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                '[dryRun] Plan de adopción:',
                '',
                reportText,
                '',
                'Llama de nuevo con dryRun:false para aplicar (requiere confirmación explícita del usuario).',
              ].join('\n'),
            },
          ],
        };
      }

      if (effectiveDryRun) {
        return {
          content: [
            {
              type: 'text' as const,
              text: ['[dryRun] Reindex calculado (sin escribir):', '', reportText].join('\n'),
            },
          ],
        };
      }

      return { content: [{ type: 'text' as const, text: reportText }] };
    },
  );
}
