/**
 * tools/vault-classify.ts — chamba_vault_classify MCP tool (CHAMBA-016 ola 3).
 *
 * Actions: list (paginated unclassified notes), apply (classify with dryRun).
 * Confirmation from the user is required before apply with dryRun:false.
 */
import {
  type ClassifyProvenanceOpts,
  classifyApply,
  classifyPlan,
  listUnclassified,
  type NoteType,
  ObsidianDetector,
  VaultReindexer,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { resolveActiveParcheVaultFull } from '../parche/active-vault.js';
import { resolveAuthor } from '../parche/provenance.js';
import { obsidianSearchRoots, type Services } from '../services.js';

const TOOL_NAME = 'chamba_vault_classify';

const DESCRIPTION =
  'Clasifica notas sin tema del vault de Obsidian. ' +
  'list: muestra notas sin clasificar (paginadas, 50 por página). ' +
  'apply: asigna temas a las notas indicadas. IMPORTANTE: dryRun:true por defecto — ' +
  'muestra el diff sin escribir. La confirmación explícita del usuario es obligatoria ' +
  'antes de llamar con dryRun:false. Máximo 50 entradas por llamada.';

const NO_VAULT_ERROR =
  'No Obsidian vault configured. Set CHAMBA_OBSIDIAN_VAULT_PATH or use the obsidian-mcp server';

const MAX_ENTRIES = 50;

/** Register `chamba_vault_classify`. */
export function registerVaultClassify(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Vault classify',
      description: DESCRIPTION,
      inputSchema: {
        action: z
          .enum(['list', 'apply'])
          .describe('Acción: list para ver notas sin clasificar, apply para clasificarlas.'),
        page: z.number().optional().describe('Página (para list, default 1).'),
        entries: z
          .array(
            z.object({
              path: z.string().describe('Ruta relativa al vault.'),
              temas: z.array(z.string()).describe('Temas a asignar.'),
              summary: z.string().optional(),
              keywords: z.array(z.string()).optional(),
              type: z.string().optional(),
              workItem: z.string().optional(),
            }),
          )
          .optional()
          .describe('Entradas a clasificar (para apply, máximo 50).'),
        dryRun: z
          .boolean()
          .optional()
          .describe('Si true (default), solo muestra el diff sin escribir.'),
      },
    },
    async ({ action, page, entries, dryRun }) => {
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
        logger.info({ tool: TOOL_NAME, action }, 'no vault configured');
        return { isError: true, content: [{ type: 'text' as const, text: NO_VAULT_ERROR }] };
      }

      logger.info({ tool: TOOL_NAME, action, vaultPath }, 'vault-classify');

      // D-Q4 (CHAMBA-021 §9): provenance for classify apply (chamba notes get
      // author/agent/written_at filled-if-missing + estado: propuesto; human
      // notes only get add-only clasificado_por/agent).
      const classifyProvenanceOpts: ClassifyProvenanceOpts = {
        author: await resolveAuthor(services, vaultResult),
        version: services.version ?? 'unknown',
        nowIso: services.clock.now().toISOString(),
      };

      // ── list ────────────────────────────────────────────────────────────────
      if (action === 'list') {
        const result = await listUnclassified(services.fs, vaultPath, {
          page: page ?? 1,
          pageSize: 50,
        });

        const lines = [
          `Notas sin clasificar: ${result.total} (página ${result.page}, ${result.items.length} en esta página)`,
          '',
        ];

        for (const item of result.items) {
          lines.push(`- **${item.path}**: ${item.title}`);
          if (item.firstParagraph) {
            lines.push(
              `  ${item.firstParagraph.slice(0, 120)}${item.firstParagraph.length > 120 ? '…' : ''}`,
            );
          }
        }

        if (result.total === 0) {
          lines.push('¡Todas las notas están clasificadas!');
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      // ── apply ───────────────────────────────────────────────────────────────
      if (action === 'apply') {
        if (!entries || entries.length === 0) {
          return {
            isError: true,
            content: [
              { type: 'text' as const, text: 'apply requiere entries (array de entradas).' },
            ],
          };
        }

        if (entries.length > MAX_ENTRIES) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Máximo ${MAX_ENTRIES} entradas por llamada (recibidas ${entries.length}).`,
              },
            ],
          };
        }

        // dryRun defaults to TRUE
        const effectiveDryRun = dryRun !== false;

        // Map entries to ClassifyEntry format
        const VALID_NOTE_TYPES = new Set<string>(['plan', 'resumen', 'nota']);
        const classifyEntries = entries.map((e) => ({
          path: e.path,
          temas: e.temas,
          summary: e.summary,
          keywords: e.keywords,
          type: e.type && VALID_NOTE_TYPES.has(e.type) ? (e.type as NoteType) : undefined,
          workItem: e.workItem,
        }));

        if (effectiveDryRun) {
          const plan = await classifyPlan(
            services.fs,
            vaultPath,
            classifyEntries,
            classifyProvenanceOpts,
          );

          const lines = [
            `[dryRun] classify apply — ${plan.diffs.length} nota(s) a actualizar, ${plan.rejected.length} rechazada(s):`,
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

          for (const rej of plan.rejected) {
            lines.push(`⚠ Rechazada "${rej.path}": ${rej.reason}`);
          }

          lines.push('');
          lines.push(
            'Llama de nuevo con dryRun:false para aplicar (requiere confirmación del usuario).',
          );

          return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
        }

        // dryRun:false — apply and reindex
        const result = await classifyApply(
          services.fs,
          vaultPath,
          classifyEntries,
          classifyProvenanceOpts,
        );

        // Reindex after classify
        const reindexer = new VaultReindexer(services.fs, vaultPath);
        await reindexer.reindex({ dryRun: false });

        const lines = [
          `classify apply: ${result.written.length} nota(s) actualizadas, ${result.rejected.length} rechazada(s).`,
          '',
        ];

        for (const w of result.written) lines.push(`✓ ${w}`);
        for (const rej of result.rejected) lines.push(`⚠ Rechazada "${rej.path}": ${rej.reason}`);

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Acción desconocida: ${action}` }],
      };
    },
  );
}
