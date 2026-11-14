/**
 * metrics/phase-summary.ts — CHAMBA-024
 *
 * Resumen y render del desglose por fase, puro (sin Node APIs, sin reloj).
 *
 * El denominador del % es el reloj de pared del ticket (endedAt - startedAt),
 * no la suma de fases. La diferencia es `unaccountedMs` ("sin fase / traspasos").
 */

import type { MetricRoute, TaskMetric } from './task-metrics.js';
import { HUMAN_WAIT_REASONS, type HumanWaitReason, PHASES, type Phase } from './task-phases.js';

export interface PhaseStat {
  phase: Phase;
  tickets: number;
  medianMs: number;
  p90Ms: number;
  /** % sobre el reloj de pared del grupo. */
  pctOfTotal: number;
  toolMs?: number;
  humanWaitMs?: number;
  inferredTickets: number;
  /** Tickets con ms === 0 && toolMs > 0 (el prompt no cerró la fase). */
  onlyToolTickets: number;
  dominant: boolean;
}

export interface HumanWaitStat {
  tickets: number;
  medianPausesPerTicket: number;
  medianBlockedMs: number;
  byReason: Array<{
    reason: HumanWaitReason;
    count: number;
    medianMs: number;
    unmeasurable: boolean;
  }>;
}

export interface PhasesReport {
  byRoute: Array<{
    route: MetricRoute;
    tickets: number;
    phases: PhaseStat[];
    /**
     * M2: "sin fase" EXCLUDES human waits that fall outside any phase — those
     * are reported separately below. Without the split, a long outside-phase
     * wait would masquerade as "unaccounted work".
     */
    unaccounted: {
      pctOfTotal: number;
      medianMs: number;
      dominant: boolean;
      outsideHumanWait: { ms: number; medianMs: number; pctOfTotal: number };
    };
    humanWaits: HumanWaitStat;
  }>;
  /** Líneas sin `phases` (previas a 1.16.0). */
  withoutBreakdown: number;
  /** Líneas con `phases` no utilizable (jsonl editado a mano). */
  malformed: number;
  /** accountedMs > wallMs. */
  inconsistent: number;
  perTicket: Array<{
    workItem: string;
    route: MetricRoute;
    dominantPhase?: Phase;
    unaccountedPct: number;
    pauses: number;
    blockedMs: number;
  }>;
}

// ─── Stats helpers ──────────────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
    : (sorted[mid] ?? 0);
}

/** p90 nearest-rank: sorted[ceil(0.9 * n) - 1], con n >= 1 (S4). */
function p90(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(0.9 * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))] ?? 0;
}

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

/** Valida un PhaseRecord crudo (posible jsonl editado a mano). Nunca produce NaN. */
function validPhaseRecord(raw: unknown): { ms: number; count: number } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (!isFiniteNonNegative(r.ms) || !isFiniteNonNegative(r.count)) return undefined;
  return { ms: r.ms, count: r.count };
}

interface ValidatedTicket {
  workItem: string;
  route: MetricRoute;
  wallMs: number;
  accountedMs: number;
  phaseMs: Partial<Record<Phase, number>>;
  phaseInferred: Partial<Record<Phase, boolean>>;
  phaseToolMs: Partial<Record<Phase, number>>;
  phaseOnlyTool: Partial<Record<Phase, boolean>>;
  phaseHumanWaitMs: Partial<Record<Phase, number>>;
  humanWaitCount: number;
  humanWaitMs: number;
  /**
   * Una entrada por ticket-reason (así se guarda en `TaskMetric.humanWaits.byReason`:
   * `{count, ms}` ya agregados por el reductor — ver task-phases.ts). `count` es el
   * número de pausas de ese motivo en TODO el ticket (sumadas, aunque alguna haya
   * sido inferida); `inferred` es sticky — true si AL MENOS una pausa de ese motivo
   * se cerró por inferencia (p. ej. `final_review`, siempre inferida por S7/D2).
   * El resumen usa `count` para el total de pausas y `ms` solo cuando `!inferred`
   * para la mediana — así una fase con pausas reales no pierde su conteo por tener
   * además una inferida, pero su duración "contaminada" no entra en la mediana.
   */
  humanWaitByReason: Partial<
    Record<HumanWaitReason, { count: number; ms: number; inferred: boolean }>
  >;
  inconsistent: boolean;
}

function validateTicket(m: TaskMetric): { ticket?: ValidatedTicket; malformed: boolean } {
  const wallMs = Math.max(0, Date.parse(m.endedAt) - Date.parse(m.startedAt));
  const phaseMs: Partial<Record<Phase, number>> = {};
  const phaseInferred: Partial<Record<Phase, boolean>> = {};
  const phaseToolMs: Partial<Record<Phase, number>> = {};
  const phaseOnlyTool: Partial<Record<Phase, boolean>> = {};
  const phaseHumanWaitMs: Partial<Record<Phase, number>> = {};
  let malformed = false;

  if (m.phases !== undefined) {
    if (typeof m.phases !== 'object' || m.phases === null || Array.isArray(m.phases)) {
      malformed = true;
    } else {
      for (const [key, rawRecord] of Object.entries(
        m.phases as unknown as Record<string, unknown>,
      )) {
        if (!(PHASES as readonly string[]).includes(key)) {
          malformed = true;
          continue;
        }
        const phase = key as Phase;
        const valid = validPhaseRecord(rawRecord);
        if (!valid) {
          // Un registro de fase malformado se ignora por completo: su `ms` nunca
          // entra en `accountedMs`. No se "pierde" — ese tiempo queda dentro de
          // `unaccountedMs` (wallMs - accountedMs) como cualquier otro tramo sin
          // fase, y el ticket se cuenta además en `malformed` para que quede claro
          // que el jsonl tiene un dato no utilizable.
          malformed = true;
          continue;
        }
        phaseMs[phase] = valid.ms;
        const rec = rawRecord as Record<string, unknown>;
        if (rec.inferred === true) phaseInferred[phase] = true;
        if (isFiniteNonNegative(rec.toolMs)) phaseToolMs[phase] = rec.toolMs;
        if (isFiniteNonNegative(rec.humanWaitMs)) phaseHumanWaitMs[phase] = rec.humanWaitMs;
        if (valid.ms === 0 && isFiniteNonNegative(rec.toolMs) && rec.toolMs > 0) {
          phaseOnlyTool[phase] = true;
        }
      }
    }
  }

  const accountedMs = Object.values(phaseMs).reduce((s, v) => s + (v ?? 0), 0);

  let humanWaitCount = 0;
  let humanWaitMs = 0;
  const humanWaitByReason: Partial<
    Record<HumanWaitReason, { count: number; ms: number; inferred: boolean }>
  > = {};
  if (m.humanWaits !== undefined) {
    const hw = m.humanWaits as unknown;
    if (
      typeof hw === 'object' &&
      hw !== null &&
      isFiniteNonNegative((hw as Record<string, unknown>).count) &&
      isFiniteNonNegative((hw as Record<string, unknown>).ms)
    ) {
      const hwObj = hw as { count: number; ms: number; byReason?: unknown };
      humanWaitCount = hwObj.count;
      humanWaitMs = hwObj.ms;
      if (typeof hwObj.byReason === 'object' && hwObj.byReason !== null) {
        for (const [reasonKey, rawEntry] of Object.entries(
          hwObj.byReason as Record<string, unknown>,
        )) {
          if (!(HUMAN_WAIT_REASONS as readonly string[]).includes(reasonKey)) {
            malformed = true;
            continue;
          }
          const entry = rawEntry as Record<string, unknown> | null;
          if (!entry || !isFiniteNonNegative(entry.ms) || !isFiniteNonNegative(entry.count)) {
            malformed = true;
            continue;
          }
          const reason = reasonKey as HumanWaitReason;
          humanWaitByReason[reason] = {
            count: entry.count,
            ms: entry.ms,
            inferred: entry.inferred === true,
          };
        }
      }
    } else {
      malformed = true;
    }
  }

  const inconsistent = accountedMs > wallMs;

  return {
    malformed,
    ticket: {
      workItem: m.workItem,
      route: m.routeFinal,
      wallMs,
      accountedMs,
      phaseMs,
      phaseInferred,
      phaseToolMs,
      phaseOnlyTool,
      phaseHumanWaitMs,
      humanWaitCount,
      humanWaitMs,
      humanWaitByReason,
      inconsistent,
    },
  };
}

// ─── Summarize ──────────────────────────────────────────────────────────────

export function summarizePhases(
  metrics: TaskMetric[],
  opts?: { route?: MetricRoute },
): PhasesReport {
  const withBreakdown = metrics.filter((m) => m.phases !== undefined || m.humanWaits !== undefined);
  const withoutBreakdown = metrics.length - withBreakdown.length;

  let malformed = 0;
  const validated: ValidatedTicket[] = [];
  for (const m of metrics) {
    if (m.phases === undefined && m.humanWaits === undefined) continue;
    const { ticket, malformed: isMalformed } = validateTicket(m);
    if (isMalformed) malformed += 1;
    if (ticket) validated.push(ticket);
  }

  // `inconsistent` cuenta sobre TODOS los tickets validados, igual que
  // `withoutBreakdown`/`malformed` — un total global, independiente de
  // `opts.route` (B1 de la review ronda 1: antes se contaba después del
  // filtro por ruta, subestimando el total cuando se pasa --route).
  const inconsistent = validated.filter((t) => t.inconsistent).length;

  const routeScoped = opts?.route ? validated.filter((t) => t.route === opts.route) : validated;
  // perTicket y byRoute excluyen los inconsistentes (su % y mediana no son
  // auditables — accountedMs > wallMs no puede venir de un reductor correcto).
  const consistent = routeScoped.filter((t) => !t.inconsistent);

  const routes: MetricRoute[] = (['trivial', 'small', 'substantial', 'risky'] as const).filter(
    (r) => (opts?.route ? r === opts.route : true) && consistent.some((t) => t.route === r),
  );

  const byRoute: PhasesReport['byRoute'] = routes.map((route) => {
    const group = consistent.filter((t) => t.route === route);
    const wallSum = group.reduce((s, t) => s + t.wallMs, 0);

    const phaseStats: PhaseStat[] = [];
    for (const phase of PHASES) {
      const inGroup = group.filter((t) => t.phaseMs[phase] !== undefined);
      if (inGroup.length === 0 && !group.some((t) => t.phaseToolMs[phase] !== undefined)) continue;
      const msValues = inGroup.map((t) => t.phaseMs[phase] ?? 0);
      const sumMs = msValues.reduce((s, v) => s + v, 0);
      const toolMsSum = group.reduce((s, t) => s + (t.phaseToolMs[phase] ?? 0), 0);
      const humanWaitMsSum = group.reduce((s, t) => s + (t.phaseHumanWaitMs[phase] ?? 0), 0);
      phaseStats.push({
        phase,
        tickets: inGroup.length,
        medianMs: median(msValues),
        p90Ms: p90(msValues),
        pctOfTotal: wallSum > 0 ? (100 * sumMs) / wallSum : 0,
        ...(toolMsSum > 0 ? { toolMs: toolMsSum } : {}),
        ...(humanWaitMsSum > 0 ? { humanWaitMs: humanWaitMsSum } : {}),
        inferredTickets: inGroup.filter((t) => t.phaseInferred[phase]).length,
        onlyToolTickets: group.filter((t) => t.phaseOnlyTool[phase]).length,
        dominant: false,
      });
    }

    // M2/B6: per ticket, clamp the "outside any phase" human-wait slice to
    // what `unaccountedMs` can actually hold. `humanWaitMs` and
    // `unaccountedMs` come from different clocks — a wait that starts
    // inside a phase and ends outside it counts whole in `humanWaits.ms`
    // but only partially in `phaseHumanWaitMs` — so without the clamp
    // `discountedMs` can go negative.
    const perTicketSplit = group.map((t) => {
      const unaccountedMs = Math.max(0, t.wallMs - t.accountedMs);
      const sumPhaseHumanWaitMs = Object.values(t.phaseHumanWaitMs).reduce(
        (s, v) => s + (v ?? 0),
        0,
      );
      const outsideMs = Math.min(Math.max(0, t.humanWaitMs - sumPhaseHumanWaitMs), unaccountedMs);
      const discountedMs = Math.max(0, unaccountedMs - outsideMs);
      return { outsideMs, discountedMs };
    });

    const unaccountedSum = perTicketSplit.reduce((s, v) => s + v.discountedMs, 0);
    const unaccountedPct = wallSum > 0 ? (100 * unaccountedSum) / wallSum : 0;
    const unaccountedMedian = median(perTicketSplit.map((v) => v.discountedMs));

    const outsideSum = perTicketSplit.reduce((s, v) => s + v.outsideMs, 0);
    const outsidePct = wallSum > 0 ? (100 * outsideSum) / wallSum : 0;
    const outsideMedian = median(perTicketSplit.map((v) => v.outsideMs));

    // Sin reloj de pared que repartir (wallSum === 0, p. ej. startedAt === endedAt
    // en todo el grupo) ningún % es significativo — nadie es "dominante".
    const maxPhasePct = phaseStats.reduce((m, p) => Math.max(m, p.pctOfTotal), 0);
    const unaccountedDominant = wallSum > 0 && unaccountedPct > maxPhasePct;
    if (wallSum > 0 && !unaccountedDominant) {
      let bestIdx = -1;
      let bestPct = -1;
      phaseStats.forEach((p, i) => {
        if (p.pctOfTotal > bestPct) {
          bestPct = p.pctOfTotal;
          bestIdx = i;
        }
      });
      if (bestIdx >= 0)
        phaseStats[bestIdx] = { ...phaseStats[bestIdx], dominant: true } as PhaseStat;
    }

    // Human waits per route
    const pausesPerTicket = group.map((t) => t.humanWaitCount);
    const blockedPerTicket = group.map((t) => t.humanWaitMs);
    const byReason: HumanWaitStat['byReason'] = [];
    for (const reason of HUMAN_WAIT_REASONS) {
      // B1 (review ronda 1): el conteo de pausas (Σ entry.count) es independiente
      // de las muestras usadas para la mediana (entry.ms, solo de entradas NO
      // inferidas). Así una fase con pausas reales no pierde su conteo por tener
      // además una inferida en el mismo ticket (p. ej. `final_review`, siempre
      // inferida por S7/D2 — se cuenta, su duración sale `n/d`).
      let count = 0;
      const samples: number[] = [];
      for (const t of group) {
        const entry = t.humanWaitByReason[reason];
        if (!entry) continue;
        count += entry.count;
        if (!entry.inferred) samples.push(entry.ms);
      }
      if (count === 0) continue;
      byReason.push({
        reason,
        count,
        medianMs: median(samples),
        unmeasurable: samples.length === 0,
      });
    }

    return {
      route,
      tickets: group.length,
      phases: phaseStats,
      unaccounted: {
        pctOfTotal: unaccountedPct,
        medianMs: unaccountedMedian,
        dominant: unaccountedDominant,
        outsideHumanWait: { ms: outsideSum, medianMs: outsideMedian, pctOfTotal: outsidePct },
      },
      humanWaits: {
        tickets: group.length,
        medianPausesPerTicket: median(pausesPerTicket),
        medianBlockedMs: median(blockedPerTicket),
        byReason,
      },
    };
  });

  const perTicket: PhasesReport['perTicket'] = consistent.map((t) => {
    let dominantPhase: Phase | undefined;
    let bestMs = -1;
    for (const [phase, ms] of Object.entries(t.phaseMs)) {
      if ((ms ?? 0) > bestMs) {
        bestMs = ms ?? 0;
        dominantPhase = phase as Phase;
      }
    }
    // N4: use the DISCOUNTED unaccounted value (B6 clamp) — the raw value
    // would let a long outside-phase human wait erase the real dominant
    // phase (`phase-summary.ts` used to compare against the bruto figure).
    const rawUnaccountedMs = Math.max(0, t.wallMs - t.accountedMs);
    const sumPhaseHumanWaitMs = Object.values(t.phaseHumanWaitMs).reduce((s, v) => s + (v ?? 0), 0);
    const outsideMs = Math.min(Math.max(0, t.humanWaitMs - sumPhaseHumanWaitMs), rawUnaccountedMs);
    const discountedMs = Math.max(0, rawUnaccountedMs - outsideMs);
    if (t.wallMs > 0 && discountedMs > bestMs) dominantPhase = undefined;
    return {
      workItem: t.workItem,
      route: t.route,
      dominantPhase,
      unaccountedPct: t.wallMs > 0 ? (100 * discountedMs) / t.wallMs : 0,
      pauses: t.humanWaitCount,
      blockedMs: t.humanWaitMs,
    };
  });

  return { byRoute, withoutBreakdown, malformed, inconsistent, perTicket };
}

// ─── Render ─────────────────────────────────────────────────────────────────

function padRight(s: string, n: number): string {
  return s.padEnd(n, ' ');
}

function padLeft(s: string, n: number): string {
  return s.padStart(n, ' ');
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

/** N13: the "sin fase" / "esperas al humano fuera de fase" row labels are
 *  longer than any real phase name — the name column must be wide enough
 *  for them too, or `padRight` is a no-op on those two rows and the numeric
 *  columns that follow drift out of alignment with the header. */
const UNACCOUNTED_LABEL = 'sin fase (excluye esperas al humano)';
const OUTSIDE_HUMAN_WAIT_LABEL = 'esperas al humano fuera de fase';
const NAME_COL_WIDTH = Math.max(14, UNACCOUNTED_LABEL.length, OUTSIDE_HUMAN_WAIT_LABEL.length);

export function renderPhasesTable(report: PhasesReport): string {
  const lines: string[] = [];

  if (report.byRoute.length === 0) {
    if (report.withoutBreakdown > 0) {
      return `${report.withoutBreakdown} ticket(s) sin desglose (líneas anteriores a 1.16.0).`;
    }
    return 'Sin métricas de fases disponibles.';
  }

  for (const group of report.byRoute) {
    lines.push(`[${group.route}] ${group.tickets} ticket(s)`);
    const header = [
      padRight('Fase', NAME_COL_WIDTH),
      padLeft('Tickets', 7),
      padLeft('Mediana', 9),
      padLeft('p90', 9),
      padLeft('%total', 8),
    ].join('  ');
    lines.push(header);
    for (const p of group.phases) {
      const marker = p.dominant ? ' ← dominante' : '';
      lines.push(
        [
          padRight(p.phase, NAME_COL_WIDTH),
          padLeft(String(p.tickets), 7),
          padLeft(formatDuration(p.medianMs), 9),
          padLeft(formatDuration(p.p90Ms), 9),
          padLeft(`${p.pctOfTotal.toFixed(1)}%`, 8),
        ].join('  ') + marker,
      );
    }
    const unaccountedMarker = group.unaccounted.dominant
      ? ' ← dominante: sin fase (excluye esperas al humano) / traspasos'
      : '';
    lines.push(
      [
        padRight(UNACCOUNTED_LABEL, NAME_COL_WIDTH),
        padLeft('', 7),
        padLeft(formatDuration(group.unaccounted.medianMs), 9),
        padLeft('', 9),
        padLeft(`${group.unaccounted.pctOfTotal.toFixed(1)}%`, 8),
      ].join('  ') + unaccountedMarker,
    );
    lines.push(
      [
        padRight(OUTSIDE_HUMAN_WAIT_LABEL, NAME_COL_WIDTH),
        padLeft('', 7),
        padLeft(formatDuration(group.unaccounted.outsideHumanWait.medianMs), 9),
        padLeft('', 9),
        padLeft(`${group.unaccounted.outsideHumanWait.pctOfTotal.toFixed(1)}%`, 8),
      ].join('  '),
    );
    lines.push('');
    lines.push('Pausas al humano:');
    lines.push(
      `  tickets: ${group.humanWaits.tickets}, mediana pausas/ticket: ${group.humanWaits.medianPausesPerTicket}, mediana bloqueado: ${formatDuration(group.humanWaits.medianBlockedMs)}`,
    );
    for (const r of group.humanWaits.byReason) {
      const value = r.unmeasurable ? 'n/d' : formatDuration(r.medianMs);
      lines.push(`    ${r.reason}: ${r.count} (mediana ${value})`);
    }
    lines.push('');
  }

  lines.push('Por ticket:');
  for (const t of report.perTicket) {
    lines.push(
      `  ${t.workItem} [${t.route}] dominante=${t.dominantPhase ?? 'sin fase / traspasos'} sinFase=${t.unaccountedPct.toFixed(1)}% pausas=${t.pauses} bloqueado=${formatDuration(t.blockedMs)}`,
    );
  }

  if (report.withoutBreakdown > 0) {
    lines.push('');
    lines.push(`${report.withoutBreakdown} ticket(s) sin desglose (líneas anteriores a 1.16.0).`);
  }
  if (report.malformed > 0) {
    lines.push(`${report.malformed} ticket(s) con datos de fase malformados — ignorados.`);
  }
  if (report.inconsistent > 0) {
    lines.push(
      `${report.inconsistent} ticket(s) inconsistentes (tiempo contado > reloj de pared) — excluidos de medianas y %.`,
    );
  }

  return lines.join('\n');
}
