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

import { join } from 'node:path';
import {
  filterMetricsSince,
  parseSinceArg,
  parseTaskMetricsJsonl,
  renderMetricsTable,
  summarizeMetricsByRoute,
} from '@chamba/core';
import { resolveWsRoot } from '../parche/resolve-ws-root.js';
import type { Services } from '../services.js';

export interface MetricsCliDeps {
  services: Services;
  stdout: (msg: string) => void;
  stderr: (msg: string) => void;
  exit: (code: number) => void;
}

function joinPath(...parts: string[]): string {
  return join(...parts);
}

function metricsJsonlPath(wsRoot: string): string {
  return joinPath(wsRoot, '.chamba', 'metrics', 'tasks.jsonl');
}

export async function runMetricsCli(argv: string[], deps: MetricsCliDeps): Promise<void> {
  const { services, stdout, stderr, exit } = deps;

  // Parse --since flag
  const sinceIdx = argv.indexOf('--since');
  const sinceArg = sinceIdx !== -1 ? argv[sinceIdx + 1] : undefined;

  let sinceDate: Date | undefined;
  if (sinceArg !== undefined) {
    const parsed = parseSinceArg(sinceArg);
    if (!parsed) {
      stderr(`Error: formato inválido para --since "${sinceArg}". Usa: 30d, 24h, 2w.`);
      exit(1);
      return;
    }
    sinceDate = parsed;
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

  // Summarize and render
  const summary = summarizeMetricsByRoute(metrics);
  const table = renderMetricsTable(summary);

  stdout(`Métricas de tareas — ${wsRoot}`);
  if (sinceDate) {
    stdout(`Filtrado: desde ${sinceDate.toISOString()}`);
  }
  stdout(`Total: ${metrics.length} ticket(s)\n`);
  stdout(table);

  exit(0);
}
