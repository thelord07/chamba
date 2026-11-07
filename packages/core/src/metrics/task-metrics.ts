/**
 * metrics/task-metrics.ts — CHAMBA-020
 *
 * Tipos y helpers puros para métricas de tareas. Sin Node APIs.
 *
 * §3.3 campos de TaskMetric. Nunca contiene texto libre del ticket ni secretos.
 */

export type QaResult = 'pass' | 'fail' | 'skipped';
export type MetricRoute = 'trivial' | 'small' | 'substantial' | 'risky';
export type MetricSource = 'ticket' | 'orq';

/**
 * Una línea de tasks.jsonl — una métrica por ticket/orq completado.
 * Sin texto del ticket, sin rutas de archivos, sin secretos.
 */
export interface TaskMetric {
  /** Identificador del ticket, e.g. "CHAMBA-020" o "orq-20261107T153010Z". */
  workItem: string;
  /** ISO UTC — cuando se inició. */
  startedAt: string;
  /** ISO UTC — cuando se cerró. */
  endedAt: string;
  /** Ruta sugerida por chamba_classify_task. */
  routeSuggested: MetricRoute;
  /** Ruta final ejecutada. */
  routeFinal: MetricRoute;
  /** true si el agente cambió la ruta sugerida. */
  overridden: boolean;
  /** Cuántas veces se escaló la ruta durante la ejecución. */
  escalations: number;
  /** Rondas de revisión del plan. */
  planReviewRounds: number;
  /** Rondas de verificación. */
  verifyRounds: number;
  /** Notas leídas con readBody en esta sesión. */
  notesRead: number;
  /** true si todos los tests pasaron. */
  testsPassed: boolean;
  /** Resultado de QA, si se ejecutó. */
  qaResult?: QaResult;
  /** true si el ticket fue entregado. */
  delivered: boolean;
  /** Fuente del ticket: "ticket" para /ticket, "orq" para /orq. */
  source: MetricSource;
}

/**
 * Estado en-vuelo — guardado en `<wsRoot>/.chamba/metrics/inflight/<workItem>.json`.
 * Acumula eventos hasta que `end` lo convierte en TaskMetric y lo elimina.
 */
export interface InflightMetric {
  workItem: string;
  startedAt: string;
  routeSuggested: MetricRoute;
  routeFinal?: MetricRoute;
  overridden?: boolean;
  escalations: number;
  planReviewRounds: number;
  verifyRounds: number;
  /** ID aleatorio del proceso MCP para validar notesRead baseline (R2). */
  sessionId: string;
  /** Baseline del contador navReadBody cuando se hizo start (R2). */
  navReadBodyBaseline: number;
  source: MetricSource;
}

// ─── Serialization ─────────────────────────────────────────────────────────────

/** Serializa un TaskMetric a una línea JSONL con \n al final. */
export function serializeTaskMetric(metric: TaskMetric): string {
  return `${JSON.stringify(metric)}\n`;
}

/** Parsea líneas de un archivo .jsonl a TaskMetric[]. Tolerante: ignora líneas vacías y malformadas. */
export function parseTaskMetricsJsonl(raw: string): TaskMetric[] {
  const results: TaskMetric[] = [];
  // Tolerar \r\n (R8)
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as unknown;
      if (typeof obj !== 'object' || obj === null) continue;
      const record = obj as Record<string, unknown>;
      if (!isTaskMetric(record)) continue;
      results.push(record as unknown as TaskMetric);
    } catch {
      // Línea malformada → ignorar (tolerante)
    }
  }
  return results;
}

function isTaskMetric(obj: Record<string, unknown>): boolean {
  return (
    typeof obj.workItem === 'string' &&
    typeof obj.startedAt === 'string' &&
    typeof obj.endedAt === 'string' &&
    typeof obj.routeSuggested === 'string' &&
    typeof obj.routeFinal === 'string' &&
    typeof obj.overridden === 'boolean' &&
    typeof obj.escalations === 'number' &&
    typeof obj.planReviewRounds === 'number' &&
    typeof obj.verifyRounds === 'number' &&
    typeof obj.notesRead === 'number' &&
    typeof obj.testsPassed === 'boolean' &&
    typeof obj.delivered === 'boolean' &&
    typeof obj.source === 'string'
  );
}

// ─── Filtering ─────────────────────────────────────────────────────────────────

/**
 * Parsea un string de --since: "Nd", "Nh", "Nw" → milisegundos.
 * Retorna null si no se puede parsear.
 */
export function parseSinceArg(since: string): Date | null {
  const match = since.match(/^(\d+)([dhw])$/i);
  if (!match) return null;
  const n = Number(match[1] ?? '0');
  const unit = (match[2] ?? 'd').toLowerCase();
  const ms = unit === 'd' ? n * 86_400_000 : unit === 'h' ? n * 3_600_000 : n * 7 * 86_400_000;
  return new Date(Date.now() - ms);
}

/** Filtra métricas por startedAt >= since (en UTC). */
export function filterMetricsSince(metrics: TaskMetric[], since: Date): TaskMetric[] {
  const sinceMs = since.getTime();
  return metrics.filter((m) => new Date(m.startedAt).getTime() >= sinceMs);
}

// ─── Summarization ─────────────────────────────────────────────────────────────

export interface RouteSummary {
  route: MetricRoute;
  source?: MetricSource; // when summarizing by source
  tickets: number;
  /** Duración mediana en segundos. */
  medianDurationSec: number;
  /** Promedio de rondas de revisión del plan (incluye ceros; promedio sobre todo el grupo). */
  avgPlanRounds: number;
  /** Promedio de rondas de verificación. */
  avgVerifyRounds: number;
  /** Porcentaje entregados (0–100). */
  pctDelivered: number;
  /** Porcentaje con al menos 1 escalación (0–100). */
  pctEscalated: number;
  /** Porcentaje con override de ruta (0–100). */
  pctOverride: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  }
  return sorted[mid] ?? 0;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function pct(count: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((count / total) * 100);
}

function summarizeGroup(
  route: MetricRoute,
  group: TaskMetric[],
  source?: MetricSource,
): RouteSummary {
  const durations = group.map((m) => {
    const start = new Date(m.startedAt).getTime();
    const end = new Date(m.endedAt).getTime();
    return Math.max(0, (end - start) / 1000);
  });
  const planRounds = group.map((m) => m.planReviewRounds);
  const verifyRounds = group.map((m) => m.verifyRounds);
  return {
    route,
    ...(source !== undefined && { source }),
    tickets: group.length,
    medianDurationSec: median(durations),
    avgPlanRounds: avg(planRounds),
    avgVerifyRounds: avg(verifyRounds),
    pctDelivered: pct(group.filter((m) => m.delivered).length, group.length),
    pctEscalated: pct(group.filter((m) => m.escalations > 0).length, group.length),
    pctOverride: pct(group.filter((m) => m.overridden).length, group.length),
  };
}

/**
 * Resumir métricas por ruta y source (§open questions).
 * Devuelve un array de summaries: primero agrupados por source+route, luego total por route.
 */
export function summarizeMetricsByRoute(metrics: TaskMetric[]): {
  bySource: RouteSummary[];
  total: RouteSummary[];
} {
  const routes: MetricRoute[] = ['trivial', 'small', 'substantial', 'risky'];
  const sources: MetricSource[] = ['ticket', 'orq'];

  const bySource: RouteSummary[] = [];
  for (const source of sources) {
    for (const route of routes) {
      const group = metrics.filter((m) => m.routeFinal === route && m.source === source);
      if (group.length === 0) continue;
      bySource.push(summarizeGroup(route, group, source));
    }
  }

  const total: RouteSummary[] = [];
  for (const route of routes) {
    const group = metrics.filter((m) => m.routeFinal === route);
    if (group.length === 0) continue;
    total.push(summarizeGroup(route, group));
  }

  return { bySource, total };
}

// ─── Rendering ─────────────────────────────────────────────────────────────────

function padRight(s: string, n: number): string {
  return s.padEnd(n, ' ');
}

function padLeft(s: string, n: number): string {
  return s.padStart(n, ' ');
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/** Renderiza la tabla de métricas como texto plano, separada por source + totales. */
export function renderMetricsTable(summary: ReturnType<typeof summarizeMetricsByRoute>): string {
  const { bySource, total } = summary;

  if (bySource.length === 0 && total.length === 0) {
    return 'Sin métricas disponibles.';
  }

  const lines: string[] = [];

  const header = [
    padRight('Fuente', 8),
    padRight('Ruta', 11),
    padLeft('Tickets', 7),
    padLeft('Duración md', 11),
    padLeft('Avg plan', 8),
    padLeft('Avg verify', 10),
    padLeft('%entregado', 10),
    padLeft('%escalado', 9),
    padLeft('%override', 9),
  ].join('  ');

  const separator = '-'.repeat(header.length);

  lines.push(separator);
  lines.push(header);
  lines.push(separator);

  // By source
  let lastSource: string | undefined;
  for (const row of bySource) {
    const src = row.source ?? '';
    if (src !== lastSource) {
      if (lastSource !== undefined) lines.push('');
      lines.push(`[${src}]`);
      lastSource = src;
    }
    lines.push(formatRow(src, row));
  }

  // Total
  if (total.length > 0) {
    lines.push('');
    lines.push('[total]');
    for (const row of total) {
      lines.push(formatRow('total', row));
    }
  }

  lines.push(separator);
  return lines.join('\n');
}

function formatRow(source: string, row: RouteSummary): string {
  return [
    padRight(source, 8),
    padRight(row.route, 11),
    padLeft(String(row.tickets), 7),
    padLeft(formatDuration(row.medianDurationSec), 11),
    padLeft(row.avgPlanRounds.toFixed(1), 8),
    padLeft(row.avgVerifyRounds.toFixed(1), 10),
    padLeft(`${row.pctDelivered}%`, 10),
    padLeft(`${row.pctEscalated}%`, 9),
    padLeft(`${row.pctOverride}%`, 9),
  ].join('  ');
}
