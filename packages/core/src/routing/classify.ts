/**
 * routing/classify.ts — CHAMBA-020
 *
 * Clasificador heurístico de ruta para un ticket/task. Sin LLM.
 *
 * Rutas: trivial < small < substantial < risky
 * Reglas §3.1:
 *   - Riesgo fuerte  → risky (no se puede bajar)
 *   - enoughToStart:false → ≥ substantial
 *   - ≥2 repos → ≥ substantial
 *   - trivial: requiere ≥1 señal trivial Y cero riesgo/alcance
 *   - sin señales → small por defecto
 *   - señal trivial + alcance/riesgo → la ruta mayor con confidence: low
 *   - low confidence si hay contradicción señal trivial vs señal de riesgo
 */

import { checkTicketCompleteness } from '../triage/ticket-completeness.js';
import { matchRiskTerms, TRIVIAL_TERMS, termRegex } from './risk-terms.js';

/**
 * Determine if a task description is "enough to start" for routing purposes.
 *
 * The triage_ticket check (`checkTicketCompleteness`) is designed for bug reports
 * (requires reproduction steps, environment, etc.). For task classification we use
 * a lighter check: does the description provide enough scope to know what to change?
 *
 * "Not enough to start" for routing: very vague single-phrase descriptions with
 * no object/scope information (< 5 words, or classic vague phrases).
 */
function isTaskEnoughToStart(task: string): boolean {
  const trimmed = task.trim();
  const words = trimmed.split(/\s+/).filter((w) => w.length > 0);
  // Very short descriptions without enough context
  if (words.length < 4) return false;

  // Use triage_ticket for longer descriptions to detect missing reproduction/scope
  // but only flag as not-enough when BOTH blocking signals are missing
  // (reproduction + expected-vs-actual) — that combination signals a vague bug report.
  // For regular tasks, we don't require those signals.
  const completeness = checkTicketCompleteness({ ticket: task });

  // A task description with ≥4 words and at least 1 signal present is enough to start.
  // We only block on truly vague inputs.
  return completeness.present.length > 0 || words.length >= 6;
}

export type Route = 'trivial' | 'small' | 'substantial' | 'risky';
export type Confidence = 'high' | 'medium' | 'low';

export interface ClassifyTaskInput {
  /** Texto del ticket o descripción de la tarea. */
  task: string;
  /** Lista de repos involucrados (nombres o URLs). */
  repos?: string[];
  /** Texto del plan (si ya existe). */
  planText?: string;
  /**
   * Criterios de aceptación del ticket (array de strings).
   * ≥4 criterios implican ≥ substantial (§3.1 señal de alcance).
   */
  acceptanceCriteria?: string[];
  /** Repos conocidos del workspace (para detectar repos no previstos). */
  knownRepos?: string[];
}

export interface ClassifyTaskResult {
  route: Route;
  /** Razones en español, máximo 5 items. */
  reasons: string[];
  /** Señales detectadas (texto breve, inglés técnico). */
  signals: string[];
  confidence: Confidence;
  /** Cuando true, el modelo puede pedir confirmación para bajar la ruta. */
  overridable: boolean;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function routeLevel(r: Route): number {
  return { trivial: 0, small: 1, substantial: 2, risky: 3 }[r];
}

function maxRoute(a: Route, b: Route): Route {
  return routeLevel(a) >= routeLevel(b) ? a : b;
}

function routeName(r: Route): string {
  return { trivial: 'trivial', small: 'small', substantial: 'substantial', risky: 'risky' }[r];
}

/** Check if text contains any trivial-signal term (reuses termRegex from risk-terms). */
function matchTrivialTerms(text: string): string[] {
  const normalized = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const matched: string[] = [];
  for (const tt of TRIVIAL_TERMS) {
    const normalizedTerm = tt.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const re = termRegex(normalizedTerm);
    if (re.test(normalized)) matched.push(tt);
  }
  return matched;
}

// ─── Classifier ───────────────────────────────────────────────────────────────

/**
 * Classify a task/ticket into one of four routes heuristically, without LLM.
 */
export function classifyTask(input: ClassifyTaskInput): ClassifyTaskResult {
  const { task, repos = [], planText = '', acceptanceCriteria = [], knownRepos = [] } = input;

  // Build composite text for analysis (join criteria array elements)
  const criteriaText = acceptanceCriteria.join('\n');
  const fullText = [task, planText, criteriaText].filter(Boolean).join('\n');

  const reasons: string[] = [];
  const signals: string[] = [];

  // ── 1. Completeness check ──────────────────────────────────────────────────
  const enoughToStart = isTaskEnoughToStart(task);

  // ── 2. Risk terms ──────────────────────────────────────────────────────────
  const riskMatches = matchRiskTerms(fullText);
  const hasStrongRisk = riskMatches.some((m) => m.strong);
  const hasAnyRisk = riskMatches.length > 0;

  for (const rm of riskMatches.slice(0, 3)) {
    signals.push(`risk:${rm.category}:${rm.term}`);
  }

  // ── 3. Trivial signals ─────────────────────────────────────────────────────
  const trivialMatches = matchTrivialTerms(fullText);
  const hasTrivial = trivialMatches.length > 0;

  for (const tm of trivialMatches.slice(0, 2)) {
    signals.push(`trivial:${tm}`);
  }

  // ── 4. Scope: repos & acceptance criteria ────────────────────────────────
  const repoCount = repos.length;

  // Detect unknown repos (repos not in knownRepos)
  const unknownRepos = knownRepos.length > 0 ? repos.filter((r) => !knownRepos.includes(r)) : [];

  if (repoCount >= 2) {
    signals.push(`multi-repo:${repoCount}`);
  }
  if (unknownRepos.length > 0) {
    signals.push(`unknown-repos:${unknownRepos.length}`);
  }

  // ≥4 acceptance criteria → scope signal (§3.1)
  const criteriaCount = acceptanceCriteria.length;
  const hasManyAC = criteriaCount >= 4;
  if (hasManyAC) {
    signals.push(`acceptance-criteria:${criteriaCount}`);
  }

  // ── 5. Determine base route ────────────────────────────────────────────────
  let route: Route = 'small'; // default
  let confidence: Confidence = 'medium';

  // Rule: strong risk → risky
  if (hasStrongRisk) {
    route = 'risky';
    confidence = 'high';
    const categories = [...new Set(riskMatches.filter((m) => m.strong).map((m) => m.category))];
    reasons.push(
      `Contiene términos de riesgo alto (${categories.join(', ')}) que requieren revisión especial.`,
    );
  }
  // Rule: enoughToStart:false → ≥ substantial
  else if (!enoughToStart) {
    route = 'substantial';
    confidence = 'medium';
    reasons.push(
      'El ticket no tiene suficiente información para comenzar — se requiere aclaración.',
    );
  }
  // Rule: ≥2 repos → ≥ substantial
  else if (repoCount >= 2) {
    route = 'substantial';
    confidence = 'medium';
    reasons.push(`Involucra ${repoCount} repositorios — requiere coordinación sustancial.`);
  }
  // Rule: ≥4 acceptance criteria → ≥ substantial (§3.1 señal de alcance)
  else if (hasManyAC) {
    route = 'substantial';
    confidence = 'medium';
    reasons.push(`${criteriaCount} criterios de aceptación — alcance sustancial confirmado.`);
  }
  // Rule: trivial (requires ≥1 trivial signal AND zero risk/scope/criteria)
  else if (hasTrivial && !hasAnyRisk && repoCount <= 1 && !hasManyAC && enoughToStart) {
    route = 'trivial';
    confidence = 'high';
    reasons.push(
      `Señales de cambio trivial detectadas (${trivialMatches.slice(0, 2).join(', ')}).`,
    );
  }
  // Default: small
  else {
    route = 'small';
    confidence = 'medium';
  }

  // Rule: trivial signal + scope/risk → route mayor con confidence:low
  if (hasTrivial && (hasAnyRisk || repoCount >= 2 || hasManyAC)) {
    confidence = 'low';
    reasons.push(
      'Contradicción: señales triviales y de riesgo/alcance simultáneas — confianza baja.',
    );
  }

  // Rule: unknown repos escalate
  if (unknownRepos.length > 0 && routeLevel(route) < routeLevel('substantial')) {
    route = maxRoute(route, 'substantial');
    reasons.push(`Repo(s) no previstos en el workspace: ${unknownRepos.join(', ')}.`);
  }

  // Rule: weak risk + not trivial → ensure at least small
  if (hasAnyRisk && !hasStrongRisk && routeLevel(route) < routeLevel('small')) {
    route = 'small';
    if (riskMatches.length > 0) {
      reasons.push('Señales de riesgo moderado detectadas.');
    }
  }

  // Build remaining reasons
  if (!enoughToStart && route !== 'substantial' && routeLevel(route) < routeLevel('substantial')) {
    // already handled above or escalated
  }
  if (reasons.length === 0) {
    if (route === 'small') {
      reasons.push('Cambio de alcance acotado sin señales de riesgo ni complejidad especial.');
    } else if (route === 'substantial') {
      reasons.push('El alcance o las señales del ticket apuntan a un cambio sustancial.');
    }
  }

  // Add risk details if not already added
  if (hasAnyRisk && !hasStrongRisk && !reasons.some((r) => r.includes('riesgo'))) {
    const categories = [...new Set(riskMatches.map((m) => m.category))];
    reasons.push(`Términos de riesgo moderado detectados: ${categories.join(', ')}.`);
  }

  // Add repo info if not added
  if (repoCount >= 2 && !reasons.some((r) => r.includes('repositorio'))) {
    reasons.push(`Cambio en ${repoCount} repositorios simultáneos.`);
  }

  // Limit reasons to 5
  const finalReasons = reasons.slice(0, 5);
  if (finalReasons.length === 0) {
    finalReasons.push(`Ruta asignada: ${routeName(route)} basado en heurísticas de señales.`);
  }

  // overridable: risky with strong signal is not easily overridable; others are
  const overridable = !(hasStrongRisk && route === 'risky');

  return {
    route,
    reasons: finalReasons,
    signals,
    confidence,
    overridable,
  };
}
