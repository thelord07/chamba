/**
 * tools/task-metrics.ts — CHAMBA-020 + CHAMBA-024 (fases y pausas al humano)
 *
 * chamba_task_metrics: tool para registrar métricas de tareas por hito.
 *
 * Tres acciones:
 *   start  — inicia el seguimiento de un ticket (abre la fase `context`)
 *   event  — registra un evento intermedio: planReview|verify|escalation|override
 *            (020) o phase_start|phase_end|human_wait_start|human_wait_end (024)
 *   end    — cierra el ticket y escribe una línea a tasks.jsonl
 *
 * Estado en-vuelo: <wsRoot>/.chamba/metrics/inflight/<workItem>.json (escritura atómica,
 * en metrics/inflight-store.ts — compartido con create-worktree(s), B2).
 * Histórico:       <wsRoot>/.chamba/metrics/tasks.jsonl
 * Lock:            services.metricsMutex (in-process, R7)
 * Gitignore:       .chamba/metrics/ en el repo git de wsRoot si aplica (R1)
 *
 * Ningún campo contiene texto libre del ticket ni secretos (§3.3). `phase` y
 * `reason` son enums cerrados (CHAMBA-024, regla de 020).
 */

import type {
  HumanWaitReason,
  InflightMetric,
  MetricRoute,
  MetricSource,
  Phase,
  QaResult,
  TaskMetric,
} from '@chamba/core';
import {
  applyPhaseEvent,
  closeOpenSpans,
  emptyPhaseState,
  ensureGitignored,
  findGitRoot,
  HUMAN_WAIT_REASONS,
  PHASES,
  serializeTaskMetric,
  WORK_ITEM_REGEX,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  getMutex,
  listInflightIds,
  lockKey,
  metricsDir,
  metricsJsonlPath,
  readInflight,
  removeInflight,
  writeInflight,
} from '../metrics/inflight-store.js';
import { withVaultLock } from '../parche/mutex.js';
import { resolveWsRoot } from '../parche/resolve-ws-root.js';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_task_metrics';

const DESCRIPTION =
  'Registra métricas de progreso para un ticket (sin texto libre, sin secretos). ' +
  'Acciones: start (inicia el seguimiento, abre la fase context), event ' +
  '(planReview|verify|escalation|override|phase_start|phase_end|human_wait_start|human_wait_end), ' +
  'end (cierra y persiste la métrica). `phase` y `reason` son enums cerrados. ' +
  'Los datos se guardan en <wsRoot>/.chamba/metrics/tasks.jsonl. ' +
  'chamba no ve tokens; usa este tool en cada hito del flujo /ticket o /orq.';

const workItemSchema = z
  .string()
  .regex(
    WORK_ITEM_REGEX,
    'workItem debe ser un identificador (ej: CHAMBA-020, orq-20261107T153010Z)',
  );

const routeSchema = z.enum(['trivial', 'small', 'substantial', 'risky']);
const sourceSchema = z.enum(['ticket', 'orq']);
const eventKindSchema = z.enum([
  'planReview',
  'verify',
  'escalation',
  'override',
  'phase_start',
  'phase_end',
  'human_wait_start',
  'human_wait_end',
]);
const phaseSchema = z.enum(PHASES);
const reasonSchema = z.enum(HUMAN_WAIT_REASONS);

// ─── Action schemas (internos, NO .strict() — B1/R9) ───────────────────────
//
// El inputSchema REGISTRADO (más abajo) es el único lugar donde .strict() surte
// efecto: el SDK de MCP valida contra el schema registrado antes de invocar el
// handler (ver plan §B1). Estos esquemas internos solo exigen los campos
// requeridos por acción; dejarlos no-estrictos evita romper llamadas que hoy
// envían claves declaradas en el registrado pero ajenas a la acción (p.ej.
// `routeFinal` en un `event`).

const LEGACY_EVENT_KINDS = ['planReview', 'verify', 'escalation', 'override'] as const;
const PHASE_EVENT_KINDS = ['phase_start', 'phase_end'] as const;

const startInputSchema = z.object({
  action: z.literal('start'),
  workItem: workItemSchema,
  routeSuggested: routeSchema,
  routeFinal: routeSchema.optional(),
  overridden: z.boolean().optional(),
  source: sourceSchema,
});

const eventInputSchema = z
  .object({
    action: z.literal('event'),
    workItem: workItemSchema,
    kind: eventKindSchema,
    toRoute: routeSchema.optional(),
    phase: phaseSchema.optional(),
    reason: reasonSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if ((PHASE_EVENT_KINDS as readonly string[]).includes(value.kind) && !value.phase) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"phase" es requerido para kind="${value.kind}".`,
        path: ['phase'],
      });
    }
    if (value.kind === 'human_wait_start' && !value.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '"reason" es requerido para kind="human_wait_start".',
        path: ['reason'],
      });
    }
    if (
      (LEGACY_EVENT_KINDS as readonly string[]).includes(value.kind) &&
      (value.phase !== undefined || value.reason !== undefined)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `"phase"/"reason" no aplican a kind="${value.kind}".`,
        path: ['kind'],
      });
    }
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
  await services.fs.writeBytes(jsonlPath, new TextEncoder().encode(existing + line));
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
    const ids = await listInflightIds(services, wsRoot);
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    for (const id of ids) {
      const inflight = await readInflight(services, wsRoot, id);
      if (inflight?.startedAt) {
        const age = now - new Date(inflight.startedAt).getTime();
        if (age > sevenDaysMs) {
          await removeInflight(services, wsRoot, id);
        }
      }
    }
  } catch {
    // dir may not exist yet
  }
}

// ─── Registration ──────────────────────────────────────────────────────────────

export function registerTaskMetrics(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Task metrics',
      description: DESCRIPTION,
      // AC-9: inputSchema REGISTRADO como z.object(...).strict() — el único lugar
      // donde la strictness surte efecto (el SDK valida contra este schema antes
      // de invocar el handler). Prohibido un z.union/discriminatedUnion aquí: el
      // SDK publicaría EMPTY_OBJECT_JSON_SCHEMA en listTools (ver plan §B1).
      inputSchema: z
        .object({
          action: z.enum(['start', 'event', 'end']).describe('Acción a ejecutar.'),
          workItem: workItemSchema.describe(
            'ID del ticket o tarea. Solo alfanumérico, guiones y puntos (ej: CHAMBA-020).',
          ),
          routeSuggested: routeSchema
            .optional()
            .describe('[start] Ruta sugerida por chamba_classify_task.'),
          source: sourceSchema
            .optional()
            .describe('[start] Fuente: "ticket" para /ticket, "orq" para /orq.'),
          kind: eventKindSchema
            .optional()
            .describe(
              '[event] planReview|verify|escalation|override|phase_start|phase_end|human_wait_start|human_wait_end.',
            ),
          toRoute: routeSchema.optional().describe('[event/escalation] Nueva ruta al escalar.'),
          phase: phaseSchema
            .optional()
            .describe('[event/phase_start|phase_end] Fase del flujo (enum cerrado).'),
          reason: reasonSchema
            .optional()
            .describe('[event/human_wait_start] Motivo de la pausa al humano (enum cerrado).'),
          testsPassed: z.boolean().optional().describe('[end] ¿Pasaron todos los tests?'),
          qaResult: z
            .enum(['pass', 'fail', 'skipped'])
            .optional()
            .describe('[end] Resultado de QA.'),
          delivered: z.boolean().optional().describe('[end] ¿Se entregó el ticket?'),
          routeFinal: routeSchema
            .optional()
            .describe('[start/end] Ruta final ejecutada (si difiere de routeSuggested).'),
          overridden: z
            .boolean()
            .optional()
            .describe('[start] ¿El agente cambió la ruta sugerida?'),
        })
        .strict(),
    },
    async (rawInput) => {
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
  await sweepStaleInflights(services, wsRoot);
  await ensureMetricsGitignored(services, wsRoot);

  const existing = await readInflight(services, wsRoot, input.workItem);
  if (existing) {
    logger.warn(
      { tool: TOOL_NAME, action: 'start', workItem: input.workItem },
      'replacing existing inflight metric — previous start had no matching end',
    );
  }

  const now = services.clock.now().toISOString();
  services.metricsSessionId ??= Math.random().toString(36).slice(2);
  const sessionId = services.metricsSessionId;
  const baseline = services.navReadBodyCount ?? 0;

  // A3: start abre implícitamente la fase `context`.
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
    phases: {},
    humanWaits: { count: 0, ms: 0, byReason: {} },
    activePhase: { phase: 'context', startedAt: now },
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

  // N2: nowIso calculado una vez, incondicionalmente, al inicio.
  const nowIso = services.clock.now().toISOString();
  let note: string | undefined;

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
    case 'phase_start':
    case 'phase_end':
    case 'human_wait_start':
    case 'human_wait_end': {
      const state = {
        phases: inflight.phases ?? {},
        humanWaits: inflight.humanWaits ?? { count: 0, ms: 0, byReason: {} },
        activePhase: inflight.activePhase,
        activeHumanWait: inflight.activeHumanWait,
      };
      const event =
        input.kind === 'phase_start'
          ? ({ kind: 'phase_start', phase: input.phase as Phase } as const)
          : input.kind === 'phase_end'
            ? ({ kind: 'phase_end', phase: input.phase as Phase } as const)
            : input.kind === 'human_wait_start'
              ? ({ kind: 'human_wait_start', reason: input.reason as HumanWaitReason } as const)
              : ({
                  kind: 'human_wait_end',
                  reason: input.reason as HumanWaitReason | undefined,
                } as const);
      const applied = applyPhaseEvent(state, event, nowIso);
      inflight.phases = applied.state.phases;
      inflight.humanWaits = applied.state.humanWaits;
      inflight.activePhase = applied.state.activePhase;
      inflight.activeHumanWait = applied.state.activeHumanWait;
      note = applied.note;
      if (note) {
        logger.warn(
          { tool: TOOL_NAME, action: 'event', workItem: input.workItem, note },
          'phase note',
        );
      }
      break;
    }
  }

  await writeInflight(services, wsRoot, inflight);
  logger.info(
    { tool: TOOL_NAME, action: 'event', workItem: input.workItem, kind: input.kind },
    'metrics event',
  );

  return okResult(
    `Evento "${input.kind}" registrado para ${input.workItem}.${note ? ` (${note})` : ''}`,
  );
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
    notesRead = Math.max(0, currentCount - inflight.navReadBodyBaseline);
  } else {
    notesRead = currentCount;
  }

  const routeFinal: MetricRoute = (input.routeFinal ??
    inflight.routeFinal ??
    inflight.routeSuggested) as MetricRoute;

  // A2/B1: cierra toda fase/pausa abierta (inferred) antes de persistir.
  const closed = closeOpenSpans(
    {
      phases: inflight.phases ?? emptyPhaseState().phases,
      humanWaits: inflight.humanWaits ?? emptyPhaseState().humanWaits,
      activePhase: inflight.activePhase,
      activeHumanWait: inflight.activeHumanWait,
    },
    now,
  );

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
    // AC-7: solo si no están vacíos.
    ...(Object.keys(closed.phases).length > 0 ? { phases: closed.phases } : {}),
    ...(closed.humanWaits.count > 0 ? { humanWaits: closed.humanWaits } : {}),
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
