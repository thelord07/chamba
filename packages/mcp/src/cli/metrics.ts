/**
 * cli/metrics.ts — CHAMBA-020
 *
 * CLI `npx @chamba/mcp metrics [--since <Nd|Nh|Nw>]`
 *
 * Lee <wsRoot>/.chamba/metrics/tasks.jsonl, filtra por --since si se especifica,
 * y renderiza la tabla por ruta separada por source + el total.
 *
 * All I/O is injectable via `MetricsCliDeps` for tests.
 */

import {
  filterMetricsSince,
  joinPath,
  type MetricRoute,
  parseSinceArg,
  parseTaskMetricsJsonl,
  renderMetricsTable,
  renderPhasesTable,
  summarizeMetricsByRoute,
  summarizePhases,
} from '@chamba/core';
import { resolveWsRoot } from '../parche/resolve-ws-root.js';
import type { Services } from '../services.js';

const ROUTES: readonly MetricRoute[] = ['trivial', 'small', 'substantial', 'risky'];

/**
 * Lee el valor de un flag; falla si falta o si el siguiente token es otro
 * flag (nit del review: `--since --phases` tomaba `--phases` como valor).
 */
function flagValue(argv: string[], name: string): { ok: true; value: string } | { ok: false } {
  const idx = argv.indexOf(name);
  if (idx === -1) return { ok: false };
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith('--')) return { ok: false };
  return { ok: true, value };
}

export interface MetricsCliDeps {
  services: Services;
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
  exit: (code: number) => void;
}

function metricsJsonlPath(wsRoot: string): string {
  return joinPath(wsRoot, '.chamba', 'metrics', 'tasks.jsonl');
}

export async function runMetricsCli(argv: string[], deps: MetricsCliDeps): Promise<void> {
  const { services, stdout, stderr, exit } = deps;

  // Parse --since flag (nit del review, B3: valor faltante o que empieza por
  // "--" ahora es un error, en vez de tomar el siguiente flag como valor).
  const hasSince = argv.includes('--since');
  let sinceDate: Date | undefined;
  if (hasSince) {
    const since = flagValue(argv, '--since');
    if (!since.ok) {
      stderr('Error: falta el valor de --since.');
      exit(1);
      return;
    }
    const parsed = parseSinceArg(since.value);
    if (!parsed) {
      stderr(`Error: formato inválido para --since "${since.value}". Usa: 30d, 24h, 2w.`);
      exit(1);
      return;
    }
    sinceDate = parsed;
  }

  // Parse --phases / --route
  const phases = argv.includes('--phases');
  const hasRoute = argv.includes('--route');
  let route: MetricRoute | undefined;
  if (hasRoute) {
    const routeFlag = flagValue(argv, '--route');
    if (!routeFlag.ok) {
      stderr('Error: falta el valor de --route.');
      exit(1);
      return;
    }
    if (!(ROUTES as readonly string[]).includes(routeFlag.value)) {
      stderr(`Error: ruta inválida "${routeFlag.value}". Usa: ${ROUTES.join(', ')}.`);
      exit(1);
      return;
    }
    route = routeFlag.value as MetricRoute;
  }

  // Resolve workspace root (same logic as the tool — shared helper)
  const wsRoot = await resolveWsRoot(services);

  const jsonlPath = metricsJsonlPath(wsRoot);

  // Read and parse metrics
  let raw = '';
  try {
    raw = await services.fs.readFile(jsonlPath);
  } catch {
    stdout(`Sin métricas en ${jsonlPath}`);
    stdout('Usa chamba_task_metrics (start/event/end) para registrar métricas de tareas.');
    exit(0);
    return;
  }

  let metrics = parseTaskMetricsJsonl(raw);

  if (metrics.length === 0) {
    stdout('El archivo de métricas existe pero no tiene líneas válidas.');
    exit(0);
    return;
  }

  // Filter by since
  if (sinceDate) {
    const before = metrics.length;
    metrics = filterMetricsSince(metrics, sinceDate);
    if (metrics.length === 0) {
      stdout(`Sin métricas desde ${sinceDate.toISOString()} (${before} total en el histórico).`);
      exit(0);
      return;
    }
  }

  if (phases) {
    const report = summarizePhases(metrics, route ? { route } : undefined);
    const table = renderPhasesTable(report);
    stdout(`Métricas de fases — ${wsRoot}`);
    if (sinceDate) {
      stdout(`Filtrado: desde ${sinceDate.toISOString()}`);
    }
    if (route) {
      stdout(`Ruta: ${route}`);
    }
    stdout(`Total: ${metrics.length} ticket(s)\n`);
    stdout(table);
    exit(0);
    return;
  }

  // AC-6/T3b: la salida por defecto (sin --phases) es idéntica a 1.15.1, byte a byte.
  // --route sin --phases filtra la tabla actual por ruta, sin cambiar su forma.
  const filtered = route ? metrics.filter((m) => m.routeFinal === route) : metrics;
  if (route && filtered.length === 0) {
    stdout(`Sin métricas para la ruta "${route}".`);
    exit(0);
    return;
  }

  const summary = summarizeMetricsByRoute(filtered);
  const table = renderMetricsTable(summary);

  stdout(`Métricas de tareas — ${wsRoot}`);
  if (sinceDate) {
    stdout(`Filtrado: desde ${sinceDate.toISOString()}`);
  }
  stdout(`Total: ${filtered.length} ticket(s)\n`);
  stdout(table);

  exit(0);
}
