/**
 * tasks/close-gate.ts — CHAMBA-022
 *
 * `evaluateCloseGate` is the heart of the ticket: pure, no IO, fully
 * testable without a filesystem. It decides whether `chamba_task close` may
 * proceed — or must be rejected with the literal list of what's missing.
 *
 * The six rules (see PLAN §2.1):
 *   1. An AC in `pendiente` with no `reason`.
 *   2. An AC in `pasa` with `evidence.length === 0`.
 *   3. The last `VerifyRun` has a failing/timed-out command.
 *   4. (O2) `route === 'risky'` and a touched repo has no `repos.<name>.verify`.
 *   5. (B2) An AC in `falla`.
 *   6. (B2) An AC in `descartado` with no matching `scope_change discard` entry.
 *
 * `partial: true` + `approvedByUser: true` exempts rules 1–5 (closes as a
 * "partial delivery", `delivered: false`) but NEVER rule 6 — a discarded AC
 * with no recorded provenance is a record-integrity problem, not pending
 * work, and `partial` cannot launder it.
 *
 * `partial` without `approvedByUser` is itself an error: chamba never
 * self-grants that approval.
 */

import { detectStyle, sameLocalPath } from '../util/local-path.js';
import type {
  AcceptanceCriterion,
  ScopeChangeEntry,
  TaskRouteProfile,
  VerifyRun,
} from './task-doc.js';

export interface CloseGateInput {
  route: TaskRouteProfile;
  criteria: AcceptanceCriterion[];
  scopeChanges: ScopeChangeEntry[];
  /** Most recent `VerifyRun` for this task, if any. */
  lastVerifyRun?: VerifyRun;
  /** Repos touched by this task that DO have `repos.<name>.verify` configured. */
  reposWithVerifyConfigured: string[];
  /** All repos touched by this task. */
  reposTouched: string[];
  /**
   * (B4) Every evidence path chamba itself has recorded for this document
   * (`doc.evidence[].path` + every `VerifyRun.commands[].evidencePath`, not
   * just the last run). An AC in `pasa` whose `evidence` entries don't
   * resolve against this set is NOT real evidence — pure, no IO: this only
   * checks against what the document itself already tracks.
   */
  knownEvidencePaths: string[];
  /** `TaskDoc.worktreePath`, if bound (B1 defense-in-depth, see rule 3). */
  documentWorktreePath?: string;
  /**
   * NB-1: OS platform string, used ONLY to case-fold the
   * `lastVerifyRun.worktreePath` vs `documentWorktreePath` comparison below
   * (win32 is case-insensitive) — defaults to `'posix'` (still strips a
   * trailing separator either way) when omitted. Pure: never touches the
   * filesystem, just a string tag the caller already has on `services`.
   */
  platform?: string;
  partial?: boolean;
  approvedByUser?: boolean;
}

export type CloseGateResult =
  | { ok: true; partial: boolean; pending: string[] }
  | { ok: false; missing: string[] };

export function evaluateCloseGate(input: CloseGateInput): CloseGateResult {
  if (input.partial === true && input.approvedByUser !== true) {
    return {
      ok: false,
      missing: [
        'un cierre parcial exige pedirle la aprobación explícita al usuario (approvedByUser=true); chamba nunca se la auto-otorga.',
      ],
    };
  }
  const exempt = input.partial === true && input.approvedByUser === true;

  // Rule 6 never exempts — record-integrity, not pending work.
  const blocking: string[] = [];
  // Rules 1, 2, 3, 4, 5 — exempted by `partial` + `approvedByUser`.
  const exemptable: string[] = [];

  for (const ac of input.criteria) {
    if (ac.estado === 'pendiente' && !ac.reason) {
      exemptable.push(`${ac.id} sigue pendiente y no tiene razón registrada.`);
    }
    if (ac.estado === 'pasa') {
      if (ac.evidence.length === 0) {
        exemptable.push(`${ac.id} dice «pasa» pero no apunta a ninguna evidencia.`);
      } else {
        const unresolved = ac.evidence.filter((e) => !input.knownEvidencePaths.includes(e));
        if (unresolved.length > 0) {
          exemptable.push(
            `${ac.id} dice «pasa» pero su evidencia no resuelve a nada registrado en el documento: ${unresolved.join(', ')}.`,
          );
        }
      }
    }
    if (ac.estado === 'falla') {
      exemptable.push(`${ac.id} está en «falla»: no se puede cerrar como entregado.`);
    }
    if (ac.estado === 'descartado') {
      const hasEntry = input.scopeChanges.some((c) => c.change === 'discard' && c.acId === ac.id);
      if (!hasEntry) {
        blocking.push(
          `${ac.id} figura descartado pero no hay registro de quién lo pidió ni por qué.`,
        );
      }
    }
  }

  if (input.lastVerifyRun) {
    for (const cmd of input.lastVerifyRun.commands) {
      if (cmd.exitCode !== 0 || cmd.timedOut) {
        exemptable.push(`verify «${cmd.name}» falló (exit ${cmd.exitCode}).`);
      }
    }
    // B1 defense-in-depth: `chamba_task verify` itself refuses to run
    // against a worktree other than the document's — this only catches a
    // document that somehow carries a run from a different worktree.
    // NB-1: compare with `sameLocalPath` (trailing-separator + win32
    // case-fold tolerant), never a raw `!==` — both values are ALSO stored
    // as realpaths now (tools/task.ts), but a document written before that
    // fix may still carry a non-normalized path.
    if (
      input.lastVerifyRun.worktreePath !== undefined &&
      input.documentWorktreePath !== undefined &&
      !sameLocalPath(
        input.lastVerifyRun.worktreePath,
        input.documentWorktreePath,
        detectStyle(input.platform ?? 'posix'),
      )
    ) {
      exemptable.push(
        'el último verify no corresponde al worktree de esta tarea; corré verify de nuevo desde el worktree correcto.',
      );
    }
  }

  if (input.route === 'risky') {
    // B2: if we couldn't determine ANY touched repo, rule 4 can't be
    // evaluated meaningfully — don't silently skip it, surface it (exemptable
    // via `partial`, same escape hatch rule 4 itself offers).
    if (input.reposTouched.length === 0) {
      exemptable.push(
        'no puedo determinar qué repo tocó esta tarea; pasá `repos` explícito en open/close o pedí un cierre parcial.',
      );
    } else {
      for (const repo of input.reposTouched) {
        if (!input.reposWithVerifyConfigured.includes(repo)) {
          exemptable.push(
            `el repo «${repo}» no tiene repos.${repo}.verify configurado; configuralo o pedí cierre parcial.`,
          );
        }
      }
    }
  }

  if (blocking.length > 0) {
    return { ok: false, missing: [...blocking, ...(exempt ? [] : exemptable)] };
  }

  if (!exempt && exemptable.length > 0) {
    return { ok: false, missing: exemptable };
  }

  return { ok: true, partial: exempt, pending: exempt ? exemptable : [] };
}
