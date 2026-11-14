/**
 * tasks/scope-change.ts — CHAMBA-022
 *
 * `applyScopeChange` is the ONLY way an acceptance criterion reaches
 * `estado: 'descartado'` (B1). It never rewrites the text of an existing
 * AC — `add` appends a new one, `reopen`/`discard` only ever touch `estado`,
 * `reason` and the append-only scope-change log.
 *
 * Pure TypeScript: no `node:` imports, no IO, no clock (the caller passes
 * `date`, taken from `ClockPort.today()`).
 */

import type { AcceptanceCriterion, ScopeChangeEntry, TaskDoc } from './task-doc.js';

export interface ScopeChangeInput {
  change: 'add' | 'reopen' | 'discard';
  /** ISO date (YYYY-MM-DD), required for the appended log entry. */
  date: string;
  /** Required for `add`. */
  text?: string;
  /** Required for `reopen`/`discard`. */
  acId?: string;
  /** Required for `reopen`/`discard`. */
  reason?: string;
  /** Required `true` for `discard` — chamba never auto-grants it. */
  requestedByUser?: boolean;
}

export type ApplyScopeChangeResult = { ok: true; doc: TaskDoc } | { ok: false; error: string };

export function applyScopeChange(doc: TaskDoc, input: ScopeChangeInput): ApplyScopeChangeResult {
  switch (input.change) {
    case 'add':
      return applyAdd(doc, input);
    case 'reopen':
      return applyReopen(doc, input);
    case 'discard':
      return applyDiscard(doc, input);
    default:
      return { ok: false, error: `cambio de alcance desconocido: "${input.change}".` };
  }
}

function applyAdd(doc: TaskDoc, input: ScopeChangeInput): ApplyScopeChangeResult {
  const text = input.text?.trim();
  if (!text) return { ok: false, error: '`add` requiere `text` con el texto del nuevo criterio.' };

  const nextId = `AC-${doc.criteria.length + 1}`;
  const newAc: AcceptanceCriterion = { id: nextId, text, estado: 'pendiente', evidence: [] };
  const entry: ScopeChangeEntry = {
    date: input.date,
    change: 'add',
    acId: nextId,
    reason: input.reason ?? '',
    requestedByUser: input.requestedByUser === true,
  };
  return {
    ok: true,
    doc: { ...doc, criteria: [...doc.criteria, newAc], scopeChanges: [...doc.scopeChanges, entry] },
  };
}

function applyReopen(doc: TaskDoc, input: ScopeChangeInput): ApplyScopeChangeResult {
  if (!input.acId) return { ok: false, error: '`reopen` requiere `acId`.' };
  const reason = input.reason?.trim();
  if (!reason) return { ok: false, error: '`reopen` requiere `reason`.' };

  const ac = doc.criteria.find((a) => a.id === input.acId);
  if (!ac) return { ok: false, error: `no existe ${input.acId} en este documento.` };
  if (ac.estado !== 'pasa' && ac.estado !== 'falla') {
    return {
      ok: false,
      error: `${ac.id} está en «${ac.estado}»; solo se puede reabrir un AC en «pasa» o «falla».`,
    };
  }

  const criteria = doc.criteria.map((a) =>
    a.id === ac.id ? { ...a, estado: 'pendiente' as const, reason } : a,
  );
  const entry: ScopeChangeEntry = {
    date: input.date,
    change: 'reopen',
    acId: ac.id,
    reason,
    requestedByUser: input.requestedByUser === true,
  };
  return { ok: true, doc: { ...doc, criteria, scopeChanges: [...doc.scopeChanges, entry] } };
}

function applyDiscard(doc: TaskDoc, input: ScopeChangeInput): ApplyScopeChangeResult {
  if (!input.acId) return { ok: false, error: '`discard` requiere `acId`.' };
  const reason = input.reason?.trim();
  if (!reason) return { ok: false, error: '`discard` requiere `reason`.' };
  if (input.requestedByUser !== true) {
    return {
      ok: false,
      error:
        'descartar un criterio exige `requestedByUser: true` — pedile permiso al usuario antes de descartarlo; chamba nunca se lo auto-otorga.',
    };
  }

  const ac = doc.criteria.find((a) => a.id === input.acId);
  if (!ac) return { ok: false, error: `no existe ${input.acId} en este documento.` };

  const criteria = doc.criteria.map((a) =>
    a.id === ac.id ? { ...a, estado: 'descartado' as const, reason } : a,
  );
  const entry: ScopeChangeEntry = {
    date: input.date,
    change: 'discard',
    acId: ac.id,
    reason,
    requestedByUser: true,
  };
  return { ok: true, doc: { ...doc, criteria, scopeChanges: [...doc.scopeChanges, entry] } };
}
