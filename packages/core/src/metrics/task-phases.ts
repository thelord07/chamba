/**
 * metrics/task-phases.ts — CHAMBA-024
 *
 * Fases de un ticket/orq + pausas al humano. Lógica pura, sin Node APIs y sin
 * reloj propio: el reductor recibe `nowIso` como parámetro.
 *
 * Nunca contiene texto libre: `phase` y `reason` son enums cerrados.
 */

// ─── Phases ─────────────────────────────────────────────────────────────────

export const PHASES = [
  'context', // load_context, load_skills, load_design, triage, classify, vault nav
  'setup', // worktree(s) + instalación de dependencias
  'plan',
  'plan_review',
  'implement',
  'test', // lint / typecheck / build / tests
  'review', // reviewer pass + conflict_preview
  'qa',
  'verify', // reservada para CHAMBA-022
  'close', // summarize_to_vault / save_plan / sync
] as const;

export type Phase = (typeof PHASES)[number];

export const HUMAN_WAIT_REASONS = [
  'clarification',
  'risky_confirm',
  'needs_approval',
  'qa_interactive',
  'final_review',
  'other',
] as const;

export type HumanWaitReason = (typeof HUMAN_WAIT_REASONS)[number];

export interface PhaseRecord {
  /** Suma de tramos cerrados por phase_start/phase_end (o inferidos). Única base del share. */
  ms: number;
  /** Tramos acumulados — las rondas repetidas lo incrementan. */
  count: number;
  /** Sticky: true si al menos un tramo se cerró por inferencia. */
  inferred?: boolean;
  /** Medido por chamba (git de create_worktree(s)). Informativo, NUNCA en el share. */
  toolMs?: number;
  toolCount?: number;
  /** Tiempo de la fase bloqueado esperando al humano (⊂ ms). */
  humanWaitMs?: number;
}

export interface HumanWaitsRecord {
  count: number;
  ms: number;
  byReason: Partial<Record<HumanWaitReason, { count: number; ms: number; inferred?: boolean }>>;
}

export type PhasesMap = Partial<Record<Phase, PhaseRecord>>;

// ─── Shared identifiers (moved from tools/task-metrics.ts, B1) ──────────────

/** workItem: sólo IDs alfanuméricos con guiones/puntos — sin texto libre. */
export const WORK_ITEM_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,64}$/;

/**
 * Normaliza un identificador para comparar slug ↔ ID sin depender de
 * case-sensitivity del filesystem (macOS/Windows insensibles, Linux sensible).
 * Minúsculas, todo lo no alfanumérico → '-', colapsa y recorta guiones.
 */
export function normalizeWorkItemId(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ─── Reducer ────────────────────────────────────────────────────────────────

export type PhaseEvent =
  | { kind: 'phase_start'; phase: Phase }
  | { kind: 'phase_end'; phase: Phase }
  | { kind: 'human_wait_start'; reason: HumanWaitReason }
  | { kind: 'human_wait_end'; reason?: HumanWaitReason }
  | { kind: 'tool_span'; phase: Phase; ms: number };

export interface PhaseState {
  phases: PhasesMap;
  humanWaits: HumanWaitsRecord;
  activePhase?: { phase: Phase; startedAt: string };
  activeHumanWait?: { reason: HumanWaitReason; startedAt: string };
}

export function emptyPhaseState(): PhaseState {
  return { phases: {}, humanWaits: { count: 0, ms: 0, byReason: {} } };
}

/** delta = max(0, nowIso - startedAt). Clamp a 0 cubre saltos de reloj hacia atrás. */
function delta(startedAt: string, nowIso: string): number {
  return Math.max(0, Date.parse(nowIso) - Date.parse(startedAt));
}

function closePhase(
  phases: PhasesMap,
  active: { phase: Phase; startedAt: string },
  nowIso: string,
  inferred: boolean,
): PhasesMap {
  const d = delta(active.startedAt, nowIso);
  const existing = phases[active.phase] ?? { ms: 0, count: 0 };
  const next: PhaseRecord = {
    ...existing,
    ms: existing.ms + d,
    count: existing.count + 1,
  };
  if (inferred || existing.inferred) next.inferred = true;
  return { ...phases, [active.phase]: next };
}

function closeHumanWait(
  humanWaits: HumanWaitsRecord,
  active: { reason: HumanWaitReason; startedAt: string },
  nowIso: string,
  inferred: boolean,
): HumanWaitsRecord {
  const d = delta(active.startedAt, nowIso);
  const existingReason = humanWaits.byReason[active.reason] ?? { count: 0, ms: 0 };
  const nextReason = {
    count: existingReason.count + 1,
    ms: existingReason.ms + d,
    ...(inferred || existingReason.inferred ? { inferred: true } : {}),
  };
  return {
    count: humanWaits.count + 1,
    ms: humanWaits.ms + d,
    byReason: { ...humanWaits.byReason, [active.reason]: nextReason },
  };
}

function addHumanWaitToActivePhase(
  phases: PhasesMap,
  activePhase: { phase: Phase; startedAt: string } | undefined,
  d: number,
): PhasesMap {
  if (!activePhase) return phases;
  const existing = phases[activePhase.phase] ?? { ms: 0, count: 0 };
  return {
    ...phases,
    [activePhase.phase]: { ...existing, humanWaitMs: (existing.humanWaitMs ?? 0) + d },
  };
}

/**
 * Aplica un evento de fase/pausa al estado. Puro: sin I/O, sin reloj propio
 * (recibe `nowIso`). Nunca lanza — una secuencia inesperada produce una `note`
 * en español, nunca rompe el flujo de /ticket o /orq.
 */
export function applyPhaseEvent(
  state: PhaseState,
  event: PhaseEvent,
  nowIso: string,
): { state: PhaseState; note?: string } {
  let phases = state.phases;
  let humanWaits = state.humanWaits;
  let activePhase = state.activePhase;
  const activeHumanWait = state.activeHumanWait;
  let note: string | undefined;

  switch (event.kind) {
    case 'phase_start': {
      if (activePhase?.phase === event.phase) {
        // M1: a repeated phase_start for the SAME already-open phase is a
        // no-op, not an inferred close+reopen — otherwise a single real
        // phase would double-count (`count: 2, inferred: true`) instead of
        // the one tramo it actually is.
        note = `Ya hay una fase "${event.phase}" abierta — se ignora el phase_start repetido.`;
        return { state: { phases, humanWaits, activePhase, activeHumanWait }, note };
      }
      if (activePhase) {
        phases = closePhase(phases, activePhase, nowIso, true);
      }
      activePhase = { phase: event.phase, startedAt: nowIso };
      return { state: { phases, humanWaits, activePhase, activeHumanWait }, note };
    }
    case 'phase_end': {
      if (!activePhase) {
        note = `No hay fase activa para cerrar "${event.phase}" — se ignora.`;
        return { state: { phases, humanWaits, activePhase, activeHumanWait }, note };
      }
      if (activePhase.phase !== event.phase) {
        note = `phase_end "${event.phase}" no coincide con la fase activa "${activePhase.phase}" — se cierra la activa como inferida.`;
        phases = closePhase(phases, activePhase, nowIso, true);
        activePhase = undefined;
        return { state: { phases, humanWaits, activePhase, activeHumanWait }, note };
      }
      phases = closePhase(phases, activePhase, nowIso, false);
      activePhase = undefined;
      return { state: { phases, humanWaits, activePhase, activeHumanWait }, note };
    }
    case 'human_wait_start': {
      let nextActiveHumanWait = activeHumanWait;
      if (nextActiveHumanWait) {
        humanWaits = closeHumanWait(humanWaits, nextActiveHumanWait, nowIso, true);
        const d = delta(nextActiveHumanWait.startedAt, nowIso);
        phases = addHumanWaitToActivePhase(phases, activePhase, d);
      }
      nextActiveHumanWait = { reason: event.reason, startedAt: nowIso };
      return {
        state: { phases, humanWaits, activePhase, activeHumanWait: nextActiveHumanWait },
        note,
      };
    }
    case 'human_wait_end': {
      if (!activeHumanWait) {
        note = 'No hay pausa al humano activa — se ignora human_wait_end.';
        return { state: { phases, humanWaits, activePhase, activeHumanWait }, note };
      }
      const d = delta(activeHumanWait.startedAt, nowIso);
      humanWaits = closeHumanWait(humanWaits, activeHumanWait, nowIso, false);
      phases = addHumanWaitToActivePhase(phases, activePhase, d);
      return {
        state: { phases, humanWaits, activePhase, activeHumanWait: undefined },
        note,
      };
    }
    case 'tool_span': {
      const existing = phases[event.phase] ?? { ms: 0, count: 0 };
      const toolMs = (existing.toolMs ?? 0) + Math.max(0, event.ms);
      const toolCount = (existing.toolCount ?? 0) + 1;
      phases = { ...phases, [event.phase]: { ...existing, toolMs, toolCount } };
      return { state: { phases, humanWaits, activePhase, activeHumanWait }, note };
    }
  }
}

/**
 * Cierra toda fase/pausa abierta, marcándolas `inferred`. La llama `end`.
 * Cierra primero `activeHumanWait` y después `activePhase` (para que el delta
 * de la espera entre en el `humanWaitMs` de la fase que aún está activa).
 */
export function closeOpenSpans(state: PhaseState, nowIso: string): PhaseState {
  let { phases, humanWaits, activePhase, activeHumanWait } = state;

  if (activeHumanWait) {
    const d = delta(activeHumanWait.startedAt, nowIso);
    humanWaits = closeHumanWait(humanWaits, activeHumanWait, nowIso, true);
    phases = addHumanWaitToActivePhase(phases, activePhase, d);
    activeHumanWait = undefined;
  }

  if (activePhase) {
    phases = closePhase(phases, activePhase, nowIso, true);
    activePhase = undefined;
  }

  return { phases, humanWaits, activePhase, activeHumanWait };
}
