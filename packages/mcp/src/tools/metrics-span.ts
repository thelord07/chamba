/**
 * tools/metrics-span.ts — CHAMBA-024 (B2)
 *
 * `recordToolSpan`: atribuye el tiempo de git medido por create_worktree(s) a
 * `phases.setup.toolMs` de la tarea activa en chamba_task_metrics — cuando es
 * atribuible. Best-effort absoluto: nunca cambia el resultado del tool que lo
 * llama, nunca lanza.
 *
 * Atribución (R7, plan §B2):
 *  - `workItem` explícito, o el hint (`ticket`/`taskSlug`) normalizado;
 *  - búsqueda por listado de `inflightDir`, nunca por lookup de ruta (case-
 *    sensitivity difiere entre macOS/Windows/Linux — B2 cross-platform);
 *  - 0 o >= 2 coincidencias → no se escribe nada (sin fallback, N2).
 *
 * Concurrencia (B7): toma `withVaultLock` UNA sola vez, en el nivel superior
 * del tool de worktree. `withVaultLock` no es reentrante — nunca llamarlo
 * anidado, ni llamar a chamba_task_metrics desde dentro.
 */

import { applyPhaseEvent, normalizeWorkItemId } from '@chamba/core';
import type { Logger } from 'pino';
import {
  getMutex,
  listInflightIds,
  lockKey,
  readInflight,
  writeInflight,
} from '../metrics/inflight-store.js';
import { withVaultLock } from '../parche/mutex.js';
import { resolveWsRoot } from '../parche/resolve-ws-root.js';
import type { Services } from '../services.js';

export interface RecordToolSpanInput {
  services: Services;
  /** workItem explícito, pasado por el prompt. */
  workItem?: string;
  /** Hint derivado (ticket/taskSlug) cuando no viene workItem explícito. */
  hint?: string;
  ms: number;
  logger: Logger;
}

/**
 * Registra el span de git dentro de `setup` de la tarea activa, si es
 * atribuible. Nunca lanza; cualquier fallo es best-effort (los logs van a
 * `logger.debug`, nunca a stdout).
 *
 * `resolveWsRoot` (que puede andar el árbol de directorios buscando el
 * marcador del workspace) se resuelve AQUÍ, en un solo punto, y solo después
 * de confirmar que hay un `target` atribuible (`workItem` o hint). Los tools
 * de worktree siempre pasan un hint (`taskSlug`/`ticket`), así que en la
 * práctica el walk corre en cada invocación; el guard protege a un caller
 * futuro sin hint. `wsRoot` ya no es parámetro: los callers
 * (create-worktree.ts / create-worktrees.ts) dejaron de resolverlo.
 */
export async function recordToolSpan(input: RecordToolSpanInput): Promise<void> {
  const { services, workItem, hint, ms, logger } = input;
  try {
    const target = workItem ?? hint;
    if (!target) return;
    const normalizedTarget = normalizeWorkItemId(target);

    const wsRoot = await resolveWsRoot(services);
    const ids = await listInflightIds(services, wsRoot);
    const matches = ids.filter((id) => normalizeWorkItemId(id) === normalizedTarget);
    if (matches.length !== 1) {
      logger.debug(
        { tool: 'metrics-span', matches: matches.length, target },
        'no attributable inflight task for worktree span',
      );
      return;
    }
    const matchedId = matches[0] as string;

    const mutex = getMutex(services);
    const key = lockKey(wsRoot);
    await withVaultLock(mutex, key, { onBusy: 'wait', logger }, async () => {
      const inflight = await readInflight(services, wsRoot, matchedId);
      if (!inflight) return;
      const state = {
        phases: inflight.phases ?? {},
        humanWaits: inflight.humanWaits ?? { count: 0, ms: 0, byReason: {} },
        activePhase: inflight.activePhase,
        activeHumanWait: inflight.activeHumanWait,
      };
      const applied = applyPhaseEvent(
        state,
        { kind: 'tool_span', phase: 'setup', ms },
        services.clock.now().toISOString(),
      );
      inflight.phases = applied.state.phases;
      await writeInflight(services, wsRoot, inflight);
    });
  } catch (err) {
    logger.debug({ tool: 'metrics-span', err: String(err) }, 'metrics span failed (best-effort)');
  }
}
