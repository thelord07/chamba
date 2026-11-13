/**
 * route-prompts.test.ts — ST-11 / §5.3
 *
 * Verifies that ticket.md and orq.md contain the routing requirements from CHAMBA-020:
 *   - All 4 routes appear (trivial, small, substantial, risky)
 *   - The one-line route announcement phrase is present
 *   - `--route` flag mention
 *   - Confirmation requirement for risky
 *   - Escalation (D3) guidance
 *   - "máx. 2 rondas" (not "6 rounds" / "6 rondas")
 *   - small route: no planner, no plan review
 *   - chamba_task_metrics milestone calls present
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function commandPath(name: string): string {
  return fileURLToPath(new URL(`../assets/commands/${name}.md`, import.meta.url));
}

function readCommand(name: string): string {
  return readFileSync(commandPath(name), 'utf8');
}

const PROMPTS: Array<{ name: string; content: string }> = [
  { name: 'ticket.md', content: readCommand('ticket') },
  { name: 'orq.md', content: readCommand('orq') },
];

for (const { name, content } of PROMPTS) {
  describe(`${name} — routing requirements (CHAMBA-020)`, () => {
    // ── All 4 routes in the table ───────────────────────────────────────────
    it('contains route trivial', () => {
      expect(content).toContain('trivial');
    });

    it('contains route small', () => {
      expect(content).toContain('small');
    });

    it('contains route substantial', () => {
      expect(content).toContain('substantial');
    });

    it('contains route risky', () => {
      expect(content).toContain('risky');
    });

    // ── Route announcement format ──────────────────────────────────────────
    it('contains one-line route announcement', () => {
      // The announce phrase: "Ruta: **X** ..." (X is a route placeholder, may be uppercase)
      expect(content).toMatch(/Ruta:\s+\*\*[A-Za-z]+\*\*/);
    });

    // ── --route flag ────────────────────────────────────────────────────────
    it('mentions --route flag', () => {
      expect(content).toContain('--route');
    });

    // ── risky confirmation ───────────────────────────────────────────────────
    it('requires confirmation for risky before implementation', () => {
      // Must mention confirmation in the context of risky
      expect(content).toMatch(/risky.{0,200}confirm/is);
    });

    // ── D3 escalation ────────────────────────────────────────────────────────
    it('contains escalation rule (D3)', () => {
      expect(content).toContain('escalat');
    });

    it('mentions escalation trigger: unexpected repo', () => {
      expect(content).toMatch(/unexpected repo|repo no previsto/i);
    });

    it('mentions escalation trigger: >15 files', () => {
      expect(content).toMatch(/15 file|15 archivos/i);
    });

    it('mentions escalation trigger: .env* files', () => {
      expect(content).toContain('.env');
    });

    // ── "máx. 2 rondas" (not "6 rounds" / "6 rondas") ──────────────────────
    it('contains "máx. 2 rondas"', () => {
      expect(content).toContain('máx. 2 rondas');
    });

    it('does not contain "6 rounds"', () => {
      expect(content).not.toContain('6 rounds');
    });

    it('does not contain "6 rondas"', () => {
      expect(content).not.toContain('6 rondas');
    });

    // ── chamba_task_metrics milestones ───────────────────────────────────────
    it('calls chamba_task_metrics with start action', () => {
      expect(content).toContain("action='start'");
    });

    it('calls chamba_task_metrics with event action', () => {
      expect(content).toContain("action='event'");
    });

    it('calls chamba_task_metrics with end action', () => {
      expect(content).toContain("action='end'");
    });

    it('mentions planReview event kind', () => {
      expect(content).toContain("kind='planReview'");
    });

    it('mentions verify event kind', () => {
      expect(content).toContain("kind='verify'");
    });

    it('mentions escalation event kind', () => {
      expect(content).toContain("kind='escalation'");
    });
  });
}

// ── small route: no planner, no plan review ────────────────────────────────────
describe('ticket.md — small route: no planner, no plan review', () => {
  const ticket = readCommand('ticket');

  it('small route does not invoke the planner subagent for plan', () => {
    // The small case explicitly says "no chamba_review_plan" and "skip step 3"
    expect(ticket).toMatch(/small.{0,300}No `chamba_review_plan`/is);
  });

  it('small route skips plan review (skip step 3)', () => {
    expect(ticket).toMatch(/small.{0,300}Skip step 3/is);
  });

  it('small route does not emit planReview events', () => {
    // The planReview event is only described in step 3 which is skipped for small
    // Verify: the skip/skip-step-3 instruction appears for small
    expect(ticket).toMatch(/small.{0,500}skip step 3/is);
  });
});

// ── orq.md — workItem format ────────────────────────────────────────────────────
describe('orq.md — workItem format and source', () => {
  const orq = readCommand('orq');

  it('uses orq-<ISO compact UTC> as workItem', () => {
    expect(orq).toContain('orq-');
  });

  it('uses source: orq', () => {
    expect(orq).toContain("source='orq'");
  });
});

// ── ticket.md — source: ticket ───────────────────────────────────────────────────
describe('ticket.md — source: ticket', () => {
  const ticket = readCommand('ticket');

  it('uses source: ticket', () => {
    expect(ticket).toContain("source='ticket'");
  });
});

// ── risky: DB guard reminder ──────────────────────────────────────────────────────
describe('ticket.md — risky route: DB guard (CHAMBA-013)', () => {
  const ticket = readCommand('ticket');

  it('mentions CHAMBA-013 guard in risky verification', () => {
    expect(ticket).toContain('CHAMBA-013');
  });

  it('mentions DB wipe patterns in risky context', () => {
    expect(ticket).toMatch(/migrate reset|drop|truncate|dropdb/i);
  });
});

// ── CHAMBA-024: fases + pausas al humano (T5) ──────────────────────────────

/** Líneas base de 1.15.1 (ver plan §E1/E5): el delta por prompt debe quedar ≤ 45. */
const BASELINE_LINES: Record<string, number> = { 'ticket.md': 205, 'orq.md': 102 };
const MAX_LINE_DELTA = 45; // presupuesto de observación acordado en el plan CHAMBA-024

const ALL_PHASES = [
  'context',
  'setup',
  'plan',
  'plan_review',
  'implement',
  'test',
  'review',
  'qa',
  'verify',
  'close',
];
/** ticket.md's 10 steps exercise all 6 pauses; orq.md has no clarification gate or QA step. */
const REASONS_BY_FILE: Record<string, string[]> = {
  'ticket.md': [
    'clarification',
    'risky_confirm',
    'needs_approval',
    'qa_interactive',
    'final_review',
    'other',
  ],
  'orq.md': ['risky_confirm', 'needs_approval', 'final_review', 'other'],
};

for (const { name, content } of PROMPTS) {
  describe(`${name} — CHAMBA-024 fases y pausas al humano`, () => {
    it("mentions phase_start (kind='phase_start')", () => {
      expect(content).toContain('phase_start');
      expect(content).toContain("kind='phase_start'");
    });
    it("mentions phase_end (kind='phase_end')", () => {
      expect(content).toContain('phase_end');
      expect(content).toMatch(/kind='phase_start'\|'phase_end'|kind='phase_end'/);
    });
    it('mentions human_wait_start', () => {
      expect(content).toContain('human_wait_start');
    });
    it('mentions human_wait_end', () => {
      expect(content).toContain('human_wait_end');
    });

    // Enum canónico: cada fase aparece entre backticks en la lista `Phases: ...`
    // del bloque CHAMBA-024 — no basta con que la palabra exista en la prosa
    // (p. ej. "plan"/"review"/"close"/"context" son palabras inglesas comunes
    // que aparecerían de todos modos).
    for (const phase of ALL_PHASES) {
      it(`lists phase "${phase}" in the canonical Phases enum`, () => {
        expect(content).toMatch(new RegExp('`' + phase + '`'));
      });
    }

    // `context` se abre implícitamente por `start` — nunca aparece con
    // phase_start/phase_end explícito; se verifica por su frase propia.
    it('context opens implicitly via start (not phase_start)', () => {
      expect(content).toMatch(/opens? (the )?`?context`?/i);
    });

    // El resto de las fases SÍ deben aparecer en una llamada real
    // `phase_start <phase>` o `phase_end <phase>` — discriminante: no basta
    // con que la palabra exista en otro lugar de la prosa. `qa` solo aplica a
    // ticket.md (orq.md no tiene paso de QA en su flujo de 8 pasos).
    const NEVER_EMITTED = new Set(['context', 'verify']);
    const EMITTED_PHASES = ALL_PHASES.filter(
      (p) => !NEVER_EMITTED.has(p) && !(name === 'orq.md' && p === 'qa'),
    );
    for (const phase of EMITTED_PHASES) {
      it(`emits phase_start/phase_end for "${phase}" (discriminating, not a bare word)`, () => {
        expect(content).toMatch(new RegExp(`phase_(start|end) ${phase}\\b`));
      });
    }

    // `verify` (fase) está reservada para CHAMBA-022 — no se emite todavía.
    it('names "verify" as reserved for CHAMBA-022, not emitted yet', () => {
      expect(content).toMatch(/`verify`\s*\(reserved for CHAMBA-022/);
    });

    // Motivos de pausa: enums específicos del dominio (discriminantes por sí
    // mismos) salvo "other", que es palabra inglesa común — se exige en la
    // posición del enum (`` `other` ``), no en cualquier prosa.
    // biome-ignore lint/style/noNonNullAssertion: name is always one of the two baselines
    for (const reason of REASONS_BY_FILE[name]!) {
      it(`names human-wait reason "${reason}"`, () => {
        if (reason === 'other') {
          expect(content).toMatch(/`other`/);
        } else {
          expect(content).toContain(reason);
        }
      });
    }

    it('requires emitting phases in trivial and small routes too', () => {
      expect(content).toMatch(/trivial.{0,40}small|all routes|todas las rutas/i);
    });

    it('does not authorize a new pause point', () => {
      expect(content).toMatch(/does not authorize|no authoriz|no autoriz/i);
    });

    it('tells the agent not to retry on a legacy-server rejection', () => {
      expect(content).toMatch(/do not retry|no retry|no reintentes/i);
    });

    it('line delta over the 1.15.1 baseline stays within budget', () => {
      const lines = content.split('\n').length;
      // biome-ignore lint/style/noNonNullAssertion: name is always one of the two baselines
      const baseline = BASELINE_LINES[name]!;
      expect(lines - baseline).toBeLessThanOrEqual(MAX_LINE_DELTA);
    });
  });
}

describe('ticket.md — CHAMBA-024 setup phase ordering', () => {
  const ticket = readCommand('ticket');

  it('phase_end setup appears after the dependency-install instruction', () => {
    const installIdx = ticket.search(/install.{0,100}dependenc/is);
    const phaseEndSetupIdx = ticket.indexOf('phase_end setup');
    expect(installIdx).toBeGreaterThan(-1);
    expect(phaseEndSetupIdx).toBeGreaterThan(installIdx);
  });

  it('passes workItem= to chamba_create_worktrees', () => {
    expect(ticket).toMatch(/chamba_create_worktrees.{0,200}workItem=/s);
  });
});

describe('orq.md — CHAMBA-024 setup phase + workItem', () => {
  const orq = readCommand('orq');

  it('passes workItem= to chamba_create_worktree', () => {
    expect(orq).toMatch(/chamba_create_worktree.{0,200}workItem=/s);
  });
});
