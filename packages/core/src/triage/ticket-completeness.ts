// Heuristic completeness check for a support/bug ticket — NO LLM. The editor's
// model still reads and judges the ticket; chamba only flags, deterministically,
// which pieces a triageable ticket usually needs and which are missing. Twin of
// the plan validator: structure checks, not reasoning.

/** The pieces a support/bug ticket usually needs to be actionable. */
export type TicketSignal =
  | 'reproduction'
  | 'expected-vs-actual'
  | 'environment'
  | 'scope'
  | 'acceptance-criteria'
  | 'severity';

/** Canonical order — also the order checks and questions come back in. */
export const TICKET_SIGNALS: readonly TicketSignal[] = [
  'reproduction',
  'expected-vs-actual',
  'environment',
  'scope',
  'acceptance-criteria',
  'severity',
];

/**
 * Signals that block investigation when absent. Without a reproduction and a
 * clear expected-vs-actual, nobody can diagnose a support ticket — these two
 * decide `enoughToStart`.
 */
const BLOCKING_SIGNALS: readonly TicketSignal[] = ['reproduction', 'expected-vs-actual'];

export interface TicketCompletenessInput {
  ticket: string;
}

export interface CompletenessCheck {
  signal: TicketSignal;
  label: string;
  present: boolean;
  /** The concrete question to ask when this signal is missing. */
  question: string;
}

export interface TicketCompleteness {
  present: TicketSignal[];
  missing: TicketSignal[];
  checks: CompletenessCheck[];
  /** Questions for the missing signals, ready to paste into the ticket. */
  questions: string[];
  /** True when both blocking signals (reproduction + expected/actual) are present. */
  enoughToStart: boolean;
  /** Fraction of signals present, 0..1 (two decimals). */
  score: number;
}

const LABELS: Record<TicketSignal, string> = {
  reproduction: 'Reproduction steps',
  'expected-vs-actual': 'Expected vs actual behaviour',
  environment: 'Environment',
  scope: 'Affected scope',
  'acceptance-criteria': 'Acceptance criteria',
  severity: 'Severity / priority',
};

const QUESTIONS: Record<TicketSignal, string> = {
  reproduction:
    'How do you reproduce it? List the exact steps (1, 2, 3…) and how often it happens (always / sometimes).',
  'expected-vs-actual': 'What did you expect to happen, and what actually happened instead?',
  environment:
    'In what environment does it occur? (app version or branch/commit, browser/OS/device, staging vs production).',
  scope:
    'What part of the product is affected? (screen, module, endpoint, route, or the specific file/flow).',
  'acceptance-criteria':
    'What has to be true for this to be considered fixed? List the acceptance criteria.',
  severity:
    'How severe/urgent is it? (who and how many are affected, whether there is a workaround).',
};

// Detectors per signal, English + Spanish. A signal is "present" if its text
// carries any of these markers. Kept deliberately loose — a false "present" is a
// nudge not enforced, and the model still reasons over the ticket.
const DETECTORS: Record<TicketSignal, RegExp> = {
  reproduction:
    /\b(reproduc\w*|repro\s*steps?|steps?\s+to\s+reproduce|how\s+to\s+reproduce|pasos?\s+para\s+reproducir|c[oó]mo\s+reproducir|to\s+reproduce)\b/i,
  'expected-vs-actual':
    /\b(expected|actual|observed|but\s+instead|instead\s+it|esperado|obtenido|en\s+su\s+lugar|resultado\s+(esperado|actual|real)|lo\s+que\s+(pasa|sucede|deber[ií]a))\b/i,
  environment:
    /\b(environment|env\b|version|versi[oó]n|browser|navegador|\bos\b|operating\s+system|device|dispositivo|staging|production|producci[oó]n|node\b|npm\b|branch|commit|build)\b/i,
  scope:
    /\b(affected|afecta|scope|alcance|module|m[oó]dulo|component|componente|endpoint|route|ruta|screen|pantalla|service|servicio|feature|funcionalidad|\barea\b|área|\bfile\b|archivo)\b/i,
  'acceptance-criteria':
    /\b(acceptance\s+criteria|criterios?\s+de\s+aceptaci[oó]n|definition\s+of\s+done|done\s+when|listo\s+cuando)\b|- \[[ xX]?\]/i,
  severity:
    /\b(severity|severidad|priority|prioridad|blocker|critical|cr[ií]tico|urgent|urgente|\bp[0-3]\b|sev[-\s]?\d|impact|impacto)\b/i,
};

/**
 * Check a support/bug ticket for the pieces it usually needs to be actionable.
 * Pure heuristics over the ticket text — no LLM, no IO. `enoughToStart` reflects
 * only the two blocking signals; the rest are advisory questions to fold in.
 */
export function checkTicketCompleteness(input: TicketCompletenessInput): TicketCompleteness {
  const text = input.ticket ?? '';
  const checks: CompletenessCheck[] = TICKET_SIGNALS.map((signal) => ({
    signal,
    label: LABELS[signal],
    present: DETECTORS[signal].test(text),
    question: QUESTIONS[signal],
  }));

  const present = checks.filter((c) => c.present).map((c) => c.signal);
  const missing = checks.filter((c) => !c.present).map((c) => c.signal);
  const questions = checks.filter((c) => !c.present).map((c) => c.question);
  const enoughToStart = BLOCKING_SIGNALS.every((s) => present.includes(s));
  const score = Math.round((present.length / TICKET_SIGNALS.length) * 100) / 100;

  return { present, missing, checks, questions, enoughToStart, score };
}

/** One-line-per-signal rendering for the MCP tool's human-readable output. */
export function renderTicketCompleteness(result: TicketCompleteness): string {
  const verdict = result.enoughToStart
    ? '✅ enough to start diagnosing'
    : '⚠ missing info needed to diagnose';
  const lines = result.checks.map((c) => `${c.present ? '✓' : '✗'} ${c.label}`);
  const questions =
    result.questions.length > 0
      ? `\nAsk the reporter:\n${result.questions.map((q) => `- ${q}`).join('\n')}`
      : '\nNothing obvious missing.';
  return [
    `Ticket completeness: ${verdict} (${result.present.length}/${TICKET_SIGNALS.length}).`,
    lines.join('\n'),
    questions,
  ].join('\n');
}
