/**
 * tasks/next-step.ts — CHAMBA-022
 *
 * `computeNextStep` derives a deterministic "what to do next" from the
 * document state — no LLM, no heuristics beyond a fixed priority order:
 * AC pendientes → verify fallido → evidencia faltante → AC en falla → cierre.
 * Feeds both `chamba_task get` (resume) and the rendered "## Siguiente paso"
 * block.
 */

import type { TaskDoc } from './task-doc.js';

export function computeNextStep(doc: TaskDoc): string {
  const pending = doc.criteria.filter((ac) => ac.estado === 'pendiente');
  if (pending.length > 0) {
    return `Resolver ${pending.map((ac) => ac.id).join(', ')} (pendiente${
      pending.length > 1 ? 's' : ''
    }).`;
  }

  const lastRun = doc.verifyRuns[doc.verifyRuns.length - 1];
  if (lastRun) {
    const failed = lastRun.commands.filter((c) => c.exitCode !== 0 || c.timedOut);
    if (failed.length > 0) {
      return `Arreglar verify: ${failed.map((c) => c.name).join(', ')} falló.`;
    }
  } else if (doc.criteria.some((ac) => ac.estado === 'pasa' || ac.estado === 'falla')) {
    return 'Correr chamba_task action=verify antes de cerrar.';
  }

  const passingWithoutEvidence = doc.criteria.filter(
    (ac) => ac.estado === 'pasa' && ac.evidence.length === 0,
  );
  if (passingWithoutEvidence.length > 0) {
    return `Adjuntar evidencia a ${passingWithoutEvidence
      .map((ac) => ac.id)
      .join(', ')} antes de cerrar.`;
  }

  const failing = doc.criteria.filter((ac) => ac.estado === 'falla');
  if (failing.length > 0) {
    return `Resolver ${failing
      .map((ac) => ac.id)
      .join(', ')} (en «falla») o pedir cierre parcial con aprobación del usuario.`;
  }

  if (doc.estadoTarea === 'cerrada') return 'Tarea cerrada.';

  return 'Todo listo — cerrar la tarea con chamba_task action=close.';
}
