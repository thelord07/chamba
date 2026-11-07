/**
 * tools/task-metrics.ts — CHAMBA-020
 *
 * chamba_task_metrics: tool para registrar métricas de tareas por hito.
 *
 * Tres acciones:
 *   start  — inicia el seguimiento de un ticket
 *   event  — registra un evento intermedio (planReview, verify, escalation, override)
 *   end    — cierra el ticket y escribe una línea a tasks.jsonl
 *
 * Estado en-vuelo: <wsRoot>/.chamba/metrics/inflight/<workItem>.json (escritura atómica).
 * Histórico:       <wsRoot>/.chamba/metrics/tasks.jsonl
 * Lock:            services.metricsMutex (in-process, R7)
 * Gitignore:       .chamba/metrics/ en el repo git de wsRoot si aplica (R1)
 *
 * Ningún campo contiene texto libre del ticket ni secretos (§3.3).
 */

import type { InflightMetric, MetricRoute, MetricSource, QaResult, TaskMetric } from '@chamba/core';
import {
  dirname,
  ensureGitignored,
  findGitRoot,
  joinPath,
  serializeTaskMetric,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { withVaultLock } from '../parche/mutex.js';
import { resolveWsRoot } from '../parche/resolve-ws-root.js';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_task_metrics';

const DESCRIPTION =
  'Registra métricas de progreso para un ticket (sin texto libre, sin secretos). ' +
  'Acciones: start (inicia el seguimiento), event (planReview|verify|escalation|override), ' +
  'end (cierra y persiste la métrica). Los datos se guardan en <wsRoot>/.chamba/metrics/tasks.jsonl. ' +
  'chamba no ve tokens; usa este tool en cada hito del flujo /ticket o /orq.';

/** workItem: sólo IDs alfanuméricos con guiones/puntos — sin texto libre. */
const WORK_ITEM_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,64}$/;

const workItemSchema = z
  .string()
  .regex(
    WORK_ITEM_REGEX,
    'workItem debe ser un identificador (ej: CHAMBA-020, orq-20261107T153010Z)',
  );

const routeSchema = z.enum(['trivial', 'small', 'substantial', 'risky']);
const sourceSchema = z.enum(['ticket', 'orq']);
const eventKindSchema = z.enum(['planReview', 'verify', 'escalation', 'override']);

// ─── Action schemas ────────────────────────────────────────────────────────────

const startInputSchema = z.object({
  action: z.literal('start'),
  workItem: workItemSchema,
  routeSuggested: routeSchema,
  routeFinal: routeSchema.optional(),
  overridden: z.boolean().optional(),
  source: sourceSchema,
});

const eventInputSchema = z.object({
  action: z.literal('event'),
  workItem: workItemSchema,
  kind: eventKindSchema,
  toRoute: routeSchema.optional(),
});

const endInputSchema = z.object({
  action: z.literal('end'),
  workItem: workItemSchema,
  testsPassed: z.boolean(),
  qaResult: z.enum(['pass', 'fail', 'skipped']).optional(),
  delivered: z.boolean(),
  routeFinal: routeSchema.optional(),
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function inflightDir(wsRoot: string): string {
  return joinPath(wsRoot, '.chamba', 'metrics', 'inflight');
}

function inflightPath(wsRoot: string, workItem: string): string {
  return joinPath(inflightDir(wsRoot), `${workItem}.json`);
}

function metricsDir(wsRoot: string): string {
  return joinPath(wsRoot, '.chamba', 'metrics');
}

function metricsJsonlPath(wsRoot: string): string {
  return joinPath(metricsDir(wsRoot), 'tasks.jsonl');
}

const textEncoder = new TextEncoder();

/**
 * Atomic write via services.fs.writeBytes (adapter already does tmp+rename).
 * Ensures parent dir exists first.
 */
async function atomicWrite(services: Services, filePath: string, content: string): Promise<void> {
  // Ensure parent dir exists (mkdir is already recursive per port spec)
  await services.fs.mkdir(dirname(filePath));
  await services.fs.writeBytes(filePath, textEncoder.encode(content));
}

/** Read inflight JSON for workItem. Returns null if not found. */
async function readInflight(
  services: Services,
  wsRoot: string,
  workItem: string,
): Promise<InflightMetric | null> {
  try {
    const raw = await services.fs.readFile(inflightPath(wsRoot, workItem));
    const obj = JSON.parse(raw) as unknown;
    if (typeof obj !== 'object' || obj === null) return null;
    return obj as InflightMetric;
  } catch {
    return null;
  }
}

/** Persist inflight JSON (atomic). */
async function writeInflight(
  services: Services,
  wsRoot: string,
  inflight: InflightMetric,
): Promise<void> {
  await atomicWrite(
    services,
    inflightPath(wsRoot, inflight.workItem),
    `${JSON.stringify(inflight)}\n`,
  );
}

/** Remove inflight file (best-effort). */
async function removeInflight(services: Services, wsRoot: string, workItem: string): Promise<void> {
  try {
    await services.fs.remove(inflightPath(wsRoot, workItem));
  } catch {
    // ignore
  }
}

/** Append a serialized line to tasks.jsonl atomically (read+append+writeBytes under lock). */
async function appendMetric(services: Services, wsRoot: string, metric: TaskMetric): Promise<void> {
  const jsonlPath = metricsJsonlPath(wsRoot);
  await services.fs.mkdir(metricsDir(wsRoot));
  let existing = '';
  try {
    existing = await services.fs.readFile(jsonlPath);
  } catch {
    // file doesn't exist yet
  }
  const line = serializeTaskMetric(metric);
  // R8: explicit \n line ending; serializeTaskMetric already adds \n
  // writeBytes is atomic (tmp+rename), so no partial writes on crash
  await services.fs.writeBytes(jsonlPath, textEncoder.encode(existing + line));
}

/** Ensure .chamba/metrics/ is gitignored in wsRoot's repo (if it's a git repo). */
async function ensureMetricsGitignored(services: Services, wsRoot: string): Promise<void> {
  try {
    const gitRoot = await findGitRoot(services.fs, wsRoot);
    if (!gitRoot) return;
    await ensureGitignored(
      services.fs,
      gitRoot,
      ['.chamba/metrics/'],
      '# chamba: métricas de tareas (datos locales — se excluyen del git)',
    );
  } catch {
    // best-effort: don't fail the tool if gitignore update fails
  }
}

/** Sweep inflights older than 7 days (R1). */
async function sweepStaleInflights(services: Services, wsRoot: string): Promise<void> {
  try {
    const dir = inflightDir(wsRoot);
    const entries = await services.fs.readDir(dir);
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (!entry.name.endsWith('.json')) continue;
      const filePath = joinPath(dir, entry.name);
      try {
        const raw = await services.fs.readFile(filePath);
        const obj = JSON.parse(raw) as { startedAt?: string };
        if (obj.startedAt) {
          const age = now - new Date(obj.startedAt).getTime();
          if (age > sevenDaysMs) {
            await services.fs.remove(filePath);
          }
        }
      } catch {
        // skip unreadable
      }
    }
  } catch {
    // dir may not exist yet
  }
}

function getMutex(services: Services): Map<string, Promise<void>> {
  if (!services.metricsMutex) {
    services.metricsMutex = new Map();
  }
  return services.metricsMutex;
}

function lockKey(wsRoot: string): string {
  return `metrics|${wsRoot}`;
}

// ─── Registration ──────────────────────────────────────────────────────────────

export function registerTaskMetrics(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Task metrics',
      description: DESCRIPTION,
      inputSchema: {
        action: z.enum(['start', 'event', 'end']).describe('Acción a ejecutar.'),
        workItem: workItemSchema.describe(
          'ID del ticket o tarea. Solo alfanumérico, guiones y puntos (ej: CHAMBA-020).',
        ),
        // start fields
        routeSuggested: routeSchema
          .optional()
          .describe('[start] Ruta sugerida por chamba_classify_task.'),
        source: sourceSchema
          .optional()
          .describe('[start] Fuente: "ticket" para /ticket, "orq" para /orq.'),
        // event fields
        kind: eventKindSchema
          .optional()
          .describe('[event] Tipo de evento: planReview|verify|escalation|override.'),
        toRoute: routeSchema.optional().describe('[event/escalation] Nueva ruta al escalar.'),
        // end fields
        testsPassed: z.boolean().optional().describe('[end] ¿Pasaron todos los tests?'),
        qaResult: z.enum(['pass', 'fail', 'skipped']).optional().describe('[end] Resultado de QA.'),
        delivered: z.boolean().optional().describe('[end] ¿Se entregó el ticket?'),
        routeFinal: routeSchema
          .optional()
          .describe('[start/end] Ruta final ejecutada (si difiere de routeSuggested).'),
        overridden: z.boolean().optional().describe('[start] ¿El agente cambió la ruta sugerida?'),
      },
    },
    async (rawInput) => {
      // Validate action-specific requirements
      let parsed:
        | z.infer<typeof startInputSchema>
        | z.infer<typeof eventInputSchema>
        | z.infer<typeof endInputSchema>;
      try {
        const action = (rawInput as { action?: string }).action;
        if (action === 'start') {
          parsed = startInputSchema.parse(rawInput);
        } else if (action === 'event') {
          parsed = eventInputSchema.parse(rawInput);
        } else if (action === 'end') {
          parsed = endInputSchema.parse(rawInput);
        } else {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Acción inválida. Usa: start, event o end.' }],
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `Error de validación: ${msg}` }],
        };
      }

      const wsRoot = await resolveWsRoot(services);
      const mutex = getMutex(services);
      const key = lockKey(wsRoot);

      const { result } = await withVaultLock(mutex, key, { onBusy: 'wait', logger }, async () => {
        if (parsed.action === 'start') {
          return handleStart(parsed, services, wsRoot, logger);
        } else if (parsed.action === 'event') {
          return handleEvent(parsed, services, wsRoot, logger);
        } else {
          return handleEnd(parsed, services, wsRoot, logger);
        }
      });

      return (
        result ?? {
          isError: true,
          content: [{ type: 'text', text: 'Error inesperado en task-metrics.' }],
        }
      );
    },
  );
}

// ─── Action handlers ──────────────────────────────────────────────────────────

async function handleStart(
  input: z.infer<typeof startInputSchema>,
  services: Services,
  wsRoot: string,
  logger: Logger,
): Promise<ReturnType<typeof okResult>> {
  // Sweep stale inflights (R1)
  await sweepStaleInflights(services, wsRoot);

  // Ensure .chamba/metrics/ is gitignored
  await ensureMetricsGitignored(services, wsRoot);

  // Warn if replacing an existing inflight (indicates start without end)
  const existing = await readInflight(services, wsRoot, input.workItem);
  if (existing) {
    logger.warn(
      { tool: TOOL_NAME, action: 'start', workItem: input.workItem },
      'replacing existing inflight metric — previous start had no matching end',
    );
  }

  const now = services.clock.now().toISOString();
  // Stable lazy init: metricsSessionId persists for the process lifetime
  // so that start and end in the same process share the same session ID.
  services.metricsSessionId ??= Math.random().toString(36).slice(2);
  const sessionId = services.metricsSessionId;
  const baseline = services.navReadBodyCount ?? 0;

  const inflight: InflightMetric = {
    workItem: input.workItem,
    startedAt: now,
    routeSuggested: input.routeSuggested as MetricRoute,
    routeFinal: (input.routeFinal ?? input.routeSuggested) as MetricRoute,
    overridden: input.overridden ?? false,
    escalations: 0,
    planReviewRounds: 0,
    verifyRounds: 0,
    sessionId,
    navReadBodyBaseline: baseline,
    source: input.source as MetricSource,
  };

  await writeInflight(services, wsRoot, inflight);
  logger.info({ tool: TOOL_NAME, action: 'start', workItem: input.workItem }, 'metrics started');

  return okResult(
    `Métricas iniciadas para ${input.workItem} (ruta: ${input.routeSuggested}, fuente: ${input.source}).`,
  );
}

async function handleEvent(
  input: z.infer<typeof eventInputSchema>,
  services: Services,
  wsRoot: string,
  logger: Logger,
): Promise<ReturnType<typeof okResult> | ReturnType<typeof errResult>> {
  const inflight = await readInflight(services, wsRoot, input.workItem);
  if (!inflight) {
    return errResult(`No hay métricas activas para "${input.workItem}". Llama a start primero.`);
  }

  switch (input.kind) {
    case 'planReview':
      inflight.planReviewRounds += 1;
      break;
    case 'verify':
      inflight.verifyRounds += 1;
      break;
    case 'escalation':
      inflight.escalations += 1;
      if (input.toRoute) {
        inflight.routeFinal = input.toRoute as MetricRoute;
      }
      break;
    case 'override':
      inflight.overridden = true;
      if (input.toRoute) {
        inflight.routeFinal = input.toRoute as MetricRoute;
      }
      break;
  }

  await writeInflight(services, wsRoot, inflight);
  logger.info(
    { tool: TOOL_NAME, action: 'event', workItem: input.workItem, kind: input.kind },
    'metrics event',
  );

  return okResult(`Evento "${input.kind}" registrado para ${input.workItem}.`);
}

async function handleEnd(
  input: z.infer<typeof endInputSchema>,
  services: Services,
  wsRoot: string,
  logger: Logger,
): Promise<ReturnType<typeof okResult> | ReturnType<typeof errResult>> {
  const inflight = await readInflight(services, wsRoot, input.workItem);
  if (!inflight) {
    // R5: end sin start → isError, no escribir línea
    return errResult(`No hay métricas activas para "${input.workItem}". Llama a start primero.`);
  }

  const now = services.clock.now().toISOString();

  // Compute notesRead (R2): compare sessionId
  const currentSession = services.metricsSessionId ?? '';
  const currentCount = services.navReadBodyCount ?? 0;
  let notesRead: number;
  if (inflight.sessionId === currentSession) {
    // Same process: subtract baseline
    notesRead = Math.max(0, currentCount - inflight.navReadBodyBaseline);
  } else {
    // Process restarted: use current count as lower bound
    notesRead = currentCount;
  }

  const routeFinal: MetricRoute = (input.routeFinal ??
    inflight.routeFinal ??
    inflight.routeSuggested) as MetricRoute;

  const metric: TaskMetric = {
    workItem: inflight.workItem,
    startedAt: inflight.startedAt,
    endedAt: now,
    routeSuggested: inflight.routeSuggested,
    routeFinal,
    overridden: inflight.overridden ?? false,
    escalations: inflight.escalations,
    planReviewRounds: inflight.planReviewRounds,
    verifyRounds: inflight.verifyRounds,
    notesRead,
    testsPassed: input.testsPassed,
    qaResult: input.qaResult as QaResult | undefined,
    delivered: input.delivered,
    source: inflight.source,
  };

  await appendMetric(services, wsRoot, metric);
  await removeInflight(services, wsRoot, input.workItem);

  logger.info(
    {
      tool: TOOL_NAME,
      action: 'end',
      workItem: input.workItem,
      route: routeFinal,
      delivered: input.delivered,
    },
    'metrics ended',
  );

  return okResult(
    `Métricas cerradas para ${input.workItem}. Ruta final: ${routeFinal}. ` +
      `Entregado: ${input.delivered ? 'sí' : 'no'}.`,
  );
}

// ─── Result helpers ────────────────────────────────────────────────────────────

function okResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errResult(text: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text }] };
}
