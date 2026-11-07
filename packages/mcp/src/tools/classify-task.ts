/**
 * tools/classify-task.ts — CHAMBA-020
 *
 * chamba_classify_task: clasifica una tarea en una de 4 rutas (trivial, small,
 * substantial, risky) usando heurísticas deterministas. Sin LLM.
 */
import { classifyTask } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_classify_task';

const DESCRIPTION =
  'Clasifica una tarea en una de 4 rutas (trivial, small, substantial, risky) usando ' +
  'heurísticas deterministas sin LLM: señales de riesgo (auth, DB, pagos, crypto, PII, ' +
  'prod, secrets), completitud del ticket, repos involucrados y señales de trivialidad. ' +
  'Devuelve { route, reasons (≤5, en español), signals, confidence, overridable }. ' +
  'Llámala después de triage_ticket para decidir el flujo de /ticket o /orq.';

export function registerClassifyTask(server: McpServer, logger: Logger, _services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Classify task',
      description: DESCRIPTION,
      inputSchema: {
        task: z.string().describe('Descripción de la tarea o ticket a clasificar.'),
        repos: z
          .array(z.string())
          .optional()
          .describe('Repositorios involucrados (nombres). ≥2 implica substantial.'),
        planText: z.string().optional().describe('Texto del plan si ya existe (-p flag).'),
        acceptanceCriteria: z
          .array(z.string())
          .optional()
          .describe(
            'Criterios de aceptación del ticket (array de strings). ≥4 criterios implican ≥ substantial.',
          ),
        knownRepos: z
          .array(z.string())
          .optional()
          .describe('Repos conocidos del workspace para detectar repos no previstos.'),
      },
      outputSchema: {
        route: z.enum(['trivial', 'small', 'substantial', 'risky']),
        reasons: z.array(z.string()),
        signals: z.array(z.string()),
        confidence: z.enum(['high', 'medium', 'low']),
        overridable: z.boolean(),
      },
    },
    async ({ task, repos, planText, acceptanceCriteria, knownRepos }) => {
      const result = classifyTask({ task, repos, planText, acceptanceCriteria, knownRepos });

      logger.info(
        { tool: TOOL_NAME, route: result.route, confidence: result.confidence },
        'task classified',
      );

      // One-line announcement for the agent (D1: announce route with reason)
      const announcement =
        `Ruta: **${result.route}** (${result.reasons[0] ?? 'sin señales especiales'}). ` +
        `Confianza: ${result.confidence}. Si prefieres otra ruta, dime o usa \`--route\`.`;

      const structuredContent = {
        route: result.route,
        reasons: result.reasons,
        signals: result.signals,
        confidence: result.confidence,
        overridable: result.overridable,
      };

      return {
        content: [{ type: 'text', text: announcement }],
        structuredContent,
      };
    },
  );
}
