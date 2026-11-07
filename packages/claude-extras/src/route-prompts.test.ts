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
