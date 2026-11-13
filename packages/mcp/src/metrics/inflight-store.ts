/**
 * metrics/inflight-store.ts — CHAMBA-024 (B1 refactor)
 *
 * Rutas, lectura/escritura atómica y mutex de los inflights de
 * chamba_task_metrics. Extraído de tools/task-metrics.ts para que
 * create-worktree(s) (B2) pueda reutilizarlo sin duplicar lógica de rutas
 * ni la key del mutex.
 */

import type { InflightMetric } from '@chamba/core';
import { dirname, joinPath } from '@chamba/core';
import type { Services } from '../services.js';

// `inflightDir`/`inflightPath`/`atomicWrite` no se exportan: ningún consumidor
// externo (ni tools/task-metrics.ts ni tools/metrics-span.ts) los importa
// directamente — todos pasan por readInflight/writeInflight/listInflightIds.

function inflightDir(wsRoot: string): string {
  return joinPath(wsRoot, '.chamba', 'metrics', 'inflight');
}

function inflightPath(wsRoot: string, workItem: string): string {
  return joinPath(inflightDir(wsRoot), `${workItem}.json`);
}

export function metricsDir(wsRoot: string): string {
  return joinPath(wsRoot, '.chamba', 'metrics');
}

export function metricsJsonlPath(wsRoot: string): string {
  return joinPath(metricsDir(wsRoot), 'tasks.jsonl');
}

const textEncoder = new TextEncoder();

/** Atomic write via services.fs.writeBytes (adapter already does tmp+rename). */
async function atomicWrite(services: Services, filePath: string, content: string): Promise<void> {
  await services.fs.mkdir(dirname(filePath));
  await services.fs.writeBytes(filePath, textEncoder.encode(content));
}

/** Read inflight JSON for workItem. Returns null if not found or unreadable. */
export async function readInflight(
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
export async function writeInflight(
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
export async function removeInflight(
  services: Services,
  wsRoot: string,
  workItem: string,
): Promise<void> {
  try {
    await services.fs.remove(inflightPath(wsRoot, workItem));
  } catch {
    // ignore
  }
}

/**
 * List inflight ids (filenames without `.json`), unmodified case — callers
 * normalize with `normalizeWorkItemId` before comparing (B2: never lookup by
 * path, filesystem case-sensitivity differs by platform).
 */
export async function listInflightIds(services: Services, wsRoot: string): Promise<string[]> {
  try {
    const entries = await services.fs.readDir(inflightDir(wsRoot));
    return entries
      .filter((e) => e.isFile && e.name.endsWith('.json'))
      .map((e) => e.name.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

export function getMutex(services: Services): Map<string, Promise<void>> {
  if (!services.metricsMutex) {
    services.metricsMutex = new Map();
  }
  return services.metricsMutex;
}

export function lockKey(wsRoot: string): string {
  return `metrics|${wsRoot}`;
}
