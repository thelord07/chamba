/**
 * routing/classify.ts — CHAMBA-020
 *
 * Clasificador heurístico de ruta para un ticket/task. Sin LLM.
 *
 * Rutas: trivial < small < substantial < risky
 * Reglas (§3.1 + review CHAMBA-020):
 *   - Riesgo fuerte, o ≥2 términos distintos de auth/payment → risky
 *   - Cualquier riesgo débil o señal de alcance (refactor, migrar, ≥2 repos,
 *     ≥4 criterios, repo no previsto) → ≥ substantial
 *   - trivial: ≥1 señal trivial y cero riesgo/alcance; ahí la incompletitud
 *     no sube la ruta (se reporta como pregunta)
 *   - enoughToStart:false (sin señal trivial) → ≥ substantial
 *   - sin señales → small
 *   - señal trivial + riesgo/alcance → confidence: low
 */

import { checkTicketCompleteness } from '../triage/ticket-completeness.js';
import type { RiskCategory } from './risk-terms.js';
import { matchRiskTerms, SCOPE_TERMS, TRIVIAL_TERMS, termRegex } from './risk-terms.js';

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

function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Terms from `list` found in `text` (reuses termRegex from risk-terms). */
function matchTerms(text: string, list: readonly string[]): string[] {
  const normalized = normalizeText(text);
  return list.filter((t) => termRegex(normalizeText(t)).test(normalized));
}

/**
 * M2 (review CHAMBA-020): version bump of a dependency to an explicit semver
 * ("subir versión de lodash a 4.17.22", "bump zod to 3.23.8") is a trivial signal.
 */
const DEPENDENCY_BUMP_RE =
  /(?<![\w])(subir|sube|actualizar|actualiza|bump|upgrade|update)(?![\w])[^\n]{0,60}?(?<![\w.])\d+\.\d+\.\d+(?![\w.])/;

function matchTrivialSignals(text: string): string[] {
  const matched = matchTerms(text, TRIVIAL_TERMS);
  const normalized = normalizeText(text);
  if (DEPENDENCY_BUMP_RE.test(normalized)) {
    // With "from a.b.c to x.y.z", only a patch change counts as trivial.
    const versions = [...normalized.matchAll(/(?<![\w.])(\d+)\.(\d+)\.\d+(?![\w.])/g)];
    const [from, to] = versions;
    const patchOnly = !from || !to || (from[1] === to[1] && from[2] === to[2]);
    if (patchOnly) matched.push('dependency-bump');
  }
  return matched;
}

/** Categories where ≥2 distinct weak terms mean the change *is* about that area. */
const RISKY_BY_COUNT: readonly RiskCategory[] = ['auth', 'payment'];

// ─── Classifier ───────────────────────────────────────────────────────────────

/**
 * Classify a task/ticket into one of four routes heuristically, without LLM.
 */
export function classifyTask(input: ClassifyTaskInput): ClassifyTaskResult {
  const { task, repos = [], planText = '', acceptanceCriteria = [], knownRepos = [] } = input;

  const criteriaText = acceptanceCriteria.join('\n');
  const fullText = [task, planText, criteriaText].filter(Boolean).join('\n');

  const reasons: string[] = [];
  const signals: string[] = [];

  // ── Signals ────────────────────────────────────────────────────────────────
  const enoughToStart = isTaskEnoughToStart(task);

  const riskMatches = matchRiskTerms(fullText);
  const strongRisk = riskMatches.filter((m) => m.strong);
  const hasAnyRisk = riskMatches.length > 0;
  for (const rm of riskMatches) signals.push(`risk:${rm.category}:${rm.term}`);

  const byCategory = new Map<RiskCategory, string[]>();
  for (const rm of riskMatches) {
    byCategory.set(rm.category, [...(byCategory.get(rm.category) ?? []), rm.term]);
  }
  const countRiskyCategories = RISKY_BY_COUNT.filter(
    (c) => new Set(byCategory.get(c) ?? []).size >= 2,
  );

  const trivialMatches = matchTrivialSignals(fullText);
  const hasTrivial = trivialMatches.length > 0;
  for (const tm of trivialMatches.slice(0, 2)) signals.push(`trivial:${tm}`);

  const scopeMatches = matchTerms(fullText, SCOPE_TERMS);
  for (const sm of scopeMatches) signals.push(`scope:${sm}`);

  const repoCount = repos.length;
  const unknownRepos = knownRepos.length > 0 ? repos.filter((r) => !knownRepos.includes(r)) : [];
  if (repoCount >= 2) signals.push(`multi-repo:${repoCount}`);
  if (unknownRepos.length > 0) signals.push(`unknown-repos:${unknownRepos.length}`);

  const criteriaCount = acceptanceCriteria.length;
  const hasManyAC = criteriaCount >= 4;
  if (hasManyAC) signals.push(`acceptance-criteria:${criteriaCount}`);

  const hasScope =
    scopeMatches.length > 0 || repoCount >= 2 || hasManyAC || unknownRepos.length > 0;

  // ── Route ──────────────────────────────────────────────────────────────────
  let route: Route;
  let confidence: Confidence = 'medium';

  if (strongRisk.length > 0 || countRiskyCategories.length > 0) {
    // Strong risk, or ≥2 distinct auth/payment terms (B1) → risky
    route = 'risky';
    confidence = 'high';
  } else if (hasAnyRisk || hasScope) {
    // Any weak risk (B1) or scope signal (B2) → at least substantial
    route = 'substantial';
  } else if (hasTrivial) {
    // M1: trivial signal with no risk/scope — incompleteness does not raise the route
    route = 'trivial';
    confidence = 'high';
  } else if (!enoughToStart) {
    route = 'substantial';
  } else {
    route = 'small';
  }

  // ── Reasons (≤ 5, español). Risk is always listed when detected (B1). ──────
  if (hasAnyRisk) {
    const detail = [...byCategory.entries()]
      .map(([cat, terms]) => `${cat}: ${[...new Set(terms)].join(', ')}`)
      .join('; ');
    const level =
      strongRisk.length > 0
        ? 'Riesgo alto'
        : countRiskyCategories.length > 0
          ? `Riesgo alto (varios términos de ${countRiskyCategories.join(', ')})`
          : 'Riesgo moderado';
    reasons.push(`${level} — señales detectadas: ${detail}.`);
  }
  if (scopeMatches.length > 0) {
    reasons.push(`Señales de alcance: ${scopeMatches.join(', ')}.`);
  }
  if (repoCount >= 2) {
    reasons.push(`Involucra ${repoCount} repositorios — requiere coordinación.`);
  }
  if (unknownRepos.length > 0) {
    reasons.push(`Repo(s) no previstos en el workspace: ${unknownRepos.join(', ')}.`);
  }
  if (hasManyAC) {
    reasons.push(`${criteriaCount} criterios de aceptación — alcance sustancial.`);
  }
  if (route === 'trivial') {
    reasons.push(`Señales de cambio trivial (${trivialMatches.slice(0, 2).join(', ')}).`);
  }
  if (!enoughToStart) {
    reasons.push(
      route === 'trivial'
        ? 'Faltan detalles en el ticket — se reporta como pregunta, no sube la ruta.'
        : 'El ticket no tiene suficiente información para comenzar — se requiere aclaración.',
    );
  }
  if (hasTrivial && (hasAnyRisk || hasScope)) {
    confidence = 'low';
    reasons.push('Contradicción: señales triviales junto a riesgo/alcance — confianza baja.');
  }
  if (reasons.length === 0) {
    reasons.push('Cambio de alcance acotado, sin señales de riesgo ni de alcance.');
  }

  const overridable = !(route === 'risky' && strongRisk.length > 0);

  return { route, reasons: reasons.slice(0, 5), signals, confidence, overridable };
}
