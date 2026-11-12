/**
 * tools/vault-topics.ts — chamba_vault_topics MCP tool (CHAMBA-016 ola 3).
 *
 * Actions: list, bootstrap, apply, add, alias, promote.
 *
 * O1: apply ALWAYS shows dryRun (VOCABULARIO.md exact content) first; only
 * writes after explicit user confirmation in a separate turn with dryRun:false.
 */
import {
  applyPromote,
  bootstrapStats,
  compactTopicTree,
  ObsidianDetector,
  parseVocabulary,
  promotePlan,
  renderVocabulary,
  VaultReindexer,
  vocabularyAdd,
  vocabularyAlias,
  writeVocabulary,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { resolveActiveParcheVaultFull } from '../parche/active-vault.js';
import { obsidianSearchRoots, type Services } from '../services.js';

const TOOL_NAME = 'chamba_vault_topics';

const DESCRIPTION =
  'Gestiona el vocabulario de temas del vault de Obsidian. ' +
  'Acciones: list (árbol + sugerencias), bootstrap (estadísticas para /vault init), ' +
  'apply (escribir VOCABULARIO.md — dryRun:true por defecto, muestra el contenido exacto; ' +
  'NUNCA llames apply con dryRun:false en el mismo turno que bootstrap ni sin aprobación ' +
  'explícita del usuario en un turno aparte), ' +
  'add/alias (modifican VOCABULARIO.md — dryRun:true por defecto, muestra el VOCABULARIO.md ' +
  'resultante; solo escribe con dryRun:false tras confirmación explícita del usuario), ' +
  'promote (mueve un TEMA propuesto al vocabulario — dryRun:true por defecto, requiere ' +
  'confirmación del usuario antes de dryRun:false ya que es una acción masiva; NO confundir ' +
  'con `chamba_vault_promote`, que promueve una NOTA de `propuesto` a `canonico`).';

const NO_VAULT_ERROR =
  'No Obsidian vault configured. Set CHAMBA_OBSIDIAN_VAULT_PATH or use the obsidian-mcp server';

const VOCAB_REL_PATH = 'temas/VOCABULARIO.md';

function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/');
}

/** Register `chamba_vault_topics`. */
export function registerVaultTopics(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Vault topics',
      description: DESCRIPTION,
      inputSchema: {
        action: z
          .enum(['list', 'bootstrap', 'apply', 'add', 'alias', 'promote'])
          .describe('Acción a ejecutar.'),
        // for apply
        nodes: z
          .array(
            z.object({
              path: z.string().describe('Ruta del nodo (ej: dev/typescript).'),
              description: z.string().describe('Descripción del nodo.'),
              aliases: z.array(z.string()).optional().describe('Aliases del nodo.'),
            }),
          )
          .optional()
          .describe('Nodos para apply.'),
        umbral_promover: z.number().optional().describe('Mínimo de notas para promover un tema.'),
        umbral_dividir: z.number().optional().describe('Máximo de notas antes de dividir un tema.'),
        generar_bases: z
          .boolean()
          .optional()
          .describe('Si true, genera archivos .base por tema raíz.'),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            'Si true (default para apply y promote), solo muestra el resultado sin escribir.',
          ),
        replace: z
          .boolean()
          .optional()
          .describe('Para apply: si true, sobreescribe VOCABULARIO.md existente.'),
        // for add/alias/promote
        path: z.string().optional().describe('Ruta del tema (para add/alias/promote).'),
        description: z.string().optional().describe('Descripción del nodo (para add).'),
        alias: z.string().optional().describe('Alias a añadir (para alias).'),
      },
    },
    async ({
      action,
      nodes,
      umbral_promover,
      umbral_dividir,
      generar_bases,
      dryRun,
      replace,
      path: topicPath,
      description: nodeDesc,
      alias,
    }) => {
      // Resolve vault
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
        logger.info({ tool: TOOL_NAME, action }, 'no vault configured');
        return { isError: true, content: [{ type: 'text' as const, text: NO_VAULT_ERROR }] };
      }

      logger.info({ tool: TOOL_NAME, action, vaultPath }, 'vault-topics');

      // ── list ────────────────────────────────────────────────────────────────
      if (action === 'list') {
        const reindexer = new VaultReindexer(services.fs, vaultPath);
        const report = await reindexer.reindex({ dryRun: true });

        const vocabAbsPath = joinPath(vaultPath, VOCAB_REL_PATH);
        let tree = '(sin vocabulario)';
        let sugerencias: string[] = [];

        if (await services.fs.exists(vocabAbsPath)) {
          const vocabContent = await services.fs.readFile(vocabAbsPath);
          const { vocabulary } = parseVocabulary(vocabContent);
          tree = compactTopicTree(vocabulary);
          sugerencias = report.sugerencias.map(
            (s) =>
              `${s.proposed}${s.readyToPromote ? ' (listo para promover)' : ''}${s.maybeSameAs && s.maybeSameAs.length > 0 ? ` ¿quizás: ${s.maybeSameAs.join(', ')}?` : ''}`,
          );
        }

        const lines = [
          `Red de conocimiento: ${report.notas} notas, ${report.sinClasificar} sin clasificar, ${report.propuestos} propuestas`,
          '',
          'Árbol de temas:',
          tree,
        ];

        if (sugerencias.length > 0) {
          lines.push('');
          lines.push('Sugerencias:');
          for (const s of sugerencias) lines.push(`- ${s}`);
        }

        if (report.indicesManualesOmitidos.length > 0) {
          lines.push('');
          lines.push('INDEX.md manuales (no sobreescritos):');
          for (const p of report.indicesManualesOmitidos) lines.push(`- ${p}`);
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      // ── bootstrap ───────────────────────────────────────────────────────────
      if (action === 'bootstrap') {
        const stats = await bootstrapStats(services.fs, vaultPath);
        const lines = [
          `Bootstrap stats (${stats.folders.length} carpetas, ${stats.tags.length} tags, ${stats.topTerms.length} términos):`,
          '',
          'Carpetas (por cantidad de notas):',
          ...stats.folders.slice(0, 15).map((f) => `  ${f.path}: ${f.count} notas`),
          '',
          'Tags existentes:',
          ...stats.tags.slice(0, 20).map((t) => `  ${t.tag}: ${t.count}`),
          '',
          'Términos frecuentes:',
          ...stats.topTerms.slice(0, 15).map((t) => `  ${t.term}: ${t.count}`),
        ];

        if (stats.indexes.length > 0) {
          lines.push('');
          lines.push('INDEX.md manuales:');
          for (const idx of stats.indexes) lines.push(`  - ${idx.path}`);
        }

        if (stats.workItems.length > 0) {
          lines.push('');
          lines.push(`Work items: ${stats.workItems.length}`);
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      // ── apply ───────────────────────────────────────────────────────────────
      if (action === 'apply') {
        // dryRun defaults to TRUE (O1)
        const effectiveDryRun = dryRun !== false;

        if (!nodes || nodes.length === 0) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'apply requiere nodes (array de {path, description, aliases?}).',
              },
            ],
          };
        }

        const renderResult = renderVocabulary(nodes, {
          umbral_promover,
          umbral_dividir,
          generar_bases,
        });

        if (renderResult.errors.length > 0) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Errores al generar vocabulario:\n${renderResult.errors.map((e) => `- ${e.message}`).join('\n')}`,
              },
            ],
          };
        }

        const vocabContent = renderResult.content ?? '';

        if (effectiveDryRun) {
          return {
            content: [
              {
                type: 'text' as const,
                text: [
                  '--- VOCABULARIO.md que se escribiría (dryRun) ---',
                  vocabContent,
                  '--- fin ---',
                  '',
                  'Muestra este contenido al usuario y llama de nuevo con dryRun:false',
                  'solo tras su "sí" explícito en un turno aparte.',
                ].join('\n'),
              },
            ],
          };
        }

        // dryRun:false — write vocabulary
        const writeResult = await writeVocabulary(services.fs, vaultPath, vocabContent, {
          dryRun: false,
          replace,
        });

        if (writeResult.error) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: writeResult.error }],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: `Vocabulario escrito en ${VOCAB_REL_PATH}.\n\n${vocabContent}`,
            },
          ],
        };
      }

      // ── add ─────────────────────────────────────────────────────────────────
      if (action === 'add') {
        if (!topicPath || !nodeDesc) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: 'add requiere path y description.' }],
          };
        }

        const vocabAbsPath = joinPath(vaultPath, VOCAB_REL_PATH);
        const exists = await services.fs.exists(vocabAbsPath);
        if (!exists) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `No existe ${VOCAB_REL_PATH}. Crea el vocabulario primero con apply.`,
              },
            ],
          };
        }

        const current = await services.fs.readFile(vocabAbsPath);
        const addResult = vocabularyAdd(current, { path: topicPath, description: nodeDesc });

        if (addResult.error) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: addResult.error }],
          };
        }

        // M4: dryRun defaults to TRUE (like apply/promote)
        const effectiveDryRun = dryRun !== false;
        if (!effectiveDryRun) {
          await services.fs.writeFile(vocabAbsPath, addResult.content);
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: effectiveDryRun
                ? [
                    `[dryRun] VOCABULARIO.md resultante de añadir "${topicPath}":`,
                    '',
                    addResult.content,
                    '',
                    'Llama de nuevo con dryRun:false para aplicar.',
                  ].join('\n')
                : `Nodo "${topicPath}" añadido a ${VOCAB_REL_PATH}.`,
            },
          ],
        };
      }

      // ── alias ───────────────────────────────────────────────────────────────
      if (action === 'alias') {
        if (!topicPath || !alias) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: 'alias requiere path y alias.' }],
          };
        }

        const vocabAbsPath = joinPath(vaultPath, VOCAB_REL_PATH);
        const exists = await services.fs.exists(vocabAbsPath);
        if (!exists) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: `No existe ${VOCAB_REL_PATH}.` }],
          };
        }

        const current = await services.fs.readFile(vocabAbsPath);
        const aliasResult = vocabularyAlias(current, topicPath, alias);

        if (aliasResult.error) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: aliasResult.error }],
          };
        }

        // M4: dryRun defaults to TRUE (like apply/promote)
        const effectiveDryRun = dryRun !== false;
        if (!effectiveDryRun) {
          await services.fs.writeFile(vocabAbsPath, aliasResult.content);
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: effectiveDryRun
                ? [
                    `[dryRun] VOCABULARIO.md resultante de añadir alias "${alias}" a "${topicPath}":`,
                    '',
                    aliasResult.content,
                    '',
                    'Llama de nuevo con dryRun:false para aplicar.',
                  ].join('\n')
                : `Alias "${alias}" añadido a "${topicPath}" en ${VOCAB_REL_PATH}.`,
            },
          ],
        };
      }

      // ── promote ─────────────────────────────────────────────────────────────
      if (action === 'promote') {
        if (!topicPath) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: 'promote requiere path.' }],
          };
        }
        if (!nodeDesc) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: 'promote requiere description.' }],
          };
        }

        // dryRun defaults to TRUE
        const effectiveDryRun = dryRun !== false;

        const plan = await promotePlan(services.fs, vaultPath, topicPath);

        if (effectiveDryRun) {
          const diffLines = plan.diffs.map(
            (d) =>
              `  ${d.path}: tags ${(d.before.tags ?? []).join(', ')} → ${(d.after.tags ?? []).join(', ')}`,
          );
          return {
            content: [
              {
                type: 'text' as const,
                text: [
                  `[dryRun] Promote "${topicPath}" afectaría ${plan.diffs.length} nota(s):`,
                  ...diffLines,
                  '',
                  'Llama de nuevo con dryRun:false para aplicar (acción masiva — requiere confirmación del usuario).',
                ].join('\n'),
              },
            ],
          };
        }

        // dryRun:false — apply
        const vocabAbsPath = joinPath(vaultPath, VOCAB_REL_PATH);
        const vocabExists = await services.fs.exists(vocabAbsPath);
        const vocabContent = vocabExists ? await services.fs.readFile(vocabAbsPath) : '';

        const applyResult = await applyPromote(
          services.fs,
          vaultPath,
          topicPath,
          plan.diffs,
          vocabContent,
          nodeDesc,
        );

        // Reindex after promote
        const reindexer = new VaultReindexer(services.fs, vaultPath);
        await reindexer.reindex({ dryRun: false });

        const lines = [
          `Promote "${topicPath}" aplicado.`,
          `  Notas actualizadas: ${applyResult.written.length}`,
        ];
        if (applyResult.vocabularyUpdated) {
          lines.push(`  Vocabulario actualizado: sí`);
        }
        if (applyResult.errors.length > 0) {
          lines.push(`  Errores: ${applyResult.errors.join('; ')}`);
        }

        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      }

      return {
        isError: true,
        content: [{ type: 'text' as const, text: `Acción desconocida: ${action}` }],
      };
    },
  );
}
