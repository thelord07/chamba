/**
 * task-prompts.test.ts — CHAMBA-022 (D3)
 *
 * Contract test for the live task document across the 5 assets `chamba_task`
 * touches: `assets/commands/{ticket,orq}.md` and
 * `assets/agents/{implementer,tester,qa}.md`. Each assertion checks a rule
 * from the plan, not just that a string is present somewhere in the prose.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function assetPath(kind: 'commands' | 'agents', name: string): string {
  return fileURLToPath(new URL(`../assets/${kind}/${name}.md`, import.meta.url));
}

function readAsset(kind: 'commands' | 'agents', name: string): string {
  return readFileSync(assetPath(kind, name), 'utf8');
}

const ticket = readAsset('commands', 'ticket');
const orq = readAsset('commands', 'orq');
const implementer = readAsset('agents', 'implementer');
const tester = readAsset('agents', 'tester');
const qa = readAsset('agents', 'qa');

const ORCHESTRATOR_PROMPTS: Array<{ name: string; content: string }> = [
  { name: 'ticket.md', content: ticket },
  { name: 'orq.md', content: orq },
];

for (const { name, content } of ORCHESTRATOR_PROMPTS) {
  describe(`${name} — chamba_task contract (CHAMBA-022)`, () => {
    it('opens the task document right after classifying, not after planning', () => {
      // `open` must appear between the classify call and the plan phase start.
      const classifyIdx = content.indexOf('chamba_classify_task');
      const openIdx = content.indexOf("action='open'");
      const planPhaseIdx = content.indexOf('phase_start plan');
      expect(classifyIdx).toBeGreaterThan(-1);
      expect(openIdx).toBeGreaterThan(classifyIdx);
      expect(planPhaseIdx).toBeGreaterThan(-1);
      expect(openIdx).toBeLessThan(planPhaseIdx);
    });

    it("skips 'open' for the trivial route", () => {
      expect(content).toMatch(/trivial.{0,80}action='open'|action='open'.{0,120}trivial/is);
    });

    it("runs 'verify' before 'close' (real evidence precedes the close gate)", () => {
      const verifyIdx = content.indexOf("action='verify'");
      const closeIdx = content.indexOf("action='close'");
      expect(verifyIdx).toBeGreaterThan(-1);
      expect(closeIdx).toBeGreaterThan(-1);
      expect(verifyIdx).toBeLessThan(closeIdx);
    });

    it('tells the agent not to route around a rejected close', () => {
      expect(content).toMatch(/don't route around|no lo rodees/i);
    });

    it("asks for partial-close approval only with the user's explicit go-ahead", () => {
      expect(content).toMatch(/partial:true.{0,40}approvedByUser:true/s);
      expect(content).toMatch(/explicit (go-ahead|approval)/i);
    });

    it('requires asking the user before discarding an acceptance criterion', () => {
      expect(content).toMatch(/discard.{0,200}go-ahead|go-ahead.{0,200}discard/is);
    });

    it('does not open a new pause point for the discard question or the partial approval', () => {
      // Both must be folded into an existing pause (the clarification gate or
      // the final review), never described as their own standalone wait.
      expect(content).toMatch(/fold(ed)?\s+(that\s+|it\s+)?into/i);
    });

    it('documents /resume reconciling the document against the real worktree', () => {
      expect(content).toMatch(/resume/i);
      expect(content).toContain("action='get'");
      expect(content).toMatch(/git -C .*status --porcelain/);
      expect(content).toMatch(/git diff --stat/);
    });

    it("passes testsPassed/delivered from close's own result to task_metrics end, not a guess", () => {
      expect(content).toMatch(/testsPassed=<the `?testsPassed`?\s+close returned>/);
      expect(content).toMatch(/delivered=<the `?delivered`?\s+close returned>/);
    });
  });
}

describe('ticket.md — worktreePath and milestone updates', () => {
  it('passes worktreePath to chamba_task after creating worktrees', () => {
    const setupIdx = ticket.indexOf('chamba_create_worktrees');
    const worktreePathIdx = ticket.indexOf('worktreePath=', setupIdx);
    expect(setupIdx).toBeGreaterThan(-1);
    expect(worktreePathIdx).toBeGreaterThan(setupIdx);
  });

  it('updates progress/nextStep/checklist after milestones, never editing by hand', () => {
    expect(ticket).toMatch(/action='update'.{0,120}progress/s);
    expect(ticket).toMatch(/never edit the document|Never edit the document/);
  });
});

describe('orq.md — worktreePath and milestone updates', () => {
  it('passes worktreePath to chamba_task after creating worktrees', () => {
    const setupIdx = orq.indexOf('chamba_create_worktree');
    const worktreePathIdx = orq.indexOf('worktreePath=', setupIdx);
    expect(setupIdx).toBeGreaterThan(-1);
    expect(worktreePathIdx).toBeGreaterThan(setupIdx);
  });

  it('updates progress/nextStep/checklist after milestones, never editing by hand', () => {
    expect(orq).toMatch(/action='update'.{0,120}progress/s);
    expect(orq).toMatch(/never edit the document/i);
  });
});

describe('ticket.md — QA evidence handoff', () => {
  it("calls chamba_task evidence kind='qa' with the qa agent's reported folder", () => {
    expect(ticket).toMatch(/action='evidence'[\s\S]{0,120}kind='qa'[\s\S]{0,120}sourcePath=/);
  });

  it('states the orchestrator (not the qa subagent) makes that call', () => {
    expect(ticket).toMatch(/qa subagent never writes to the vault/i);
  });
});

describe('agents/implementer.md — reports milestones, never writes the vault/AC text', () => {
  it('reports milestones to the orchestrator', () => {
    expect(implementer).toMatch(/report(s)? milestones/i);
  });

  it('never writes to the vault itself', () => {
    expect(implementer).toMatch(/never write to the vault/i);
  });

  it("never edits the task document or an acceptance criterion's text", () => {
    expect(implementer).toMatch(
      /never\s+edit\s+the\s+task\s+document\s+or\s+an\s+acceptance\s+criterion/i,
    );
  });
});

describe("agents/tester.md — verify evidence is chamba's job, not fabricated", () => {
  it("states chamba runs 'verify' itself and writes real evidence", () => {
    expect(tester).toMatch(/chamba runs the configured `?verify`? commands itself/i);
  });

  it('forbids fabricating verify output', () => {
    expect(tester).toMatch(/never fabricate verify output/i);
  });

  it("forbids editing a task's evidence files", () => {
    expect(tester).toMatch(/never\s+edit\s+a\s+file\s+under\s+a\s+task's\s+`?evidencia/i);
  });
});

describe('agents/qa.md — reports the run folder, never writes to the vault', () => {
  it('reports the run folder path for the orchestrator to sync', () => {
    expect(qa).toMatch(/hand\s+the\s+orchestrator\s+that\s+run\s+folder's\s+path/i);
    expect(qa).toMatch(/action='evidence'/);
  });

  it('states the qa subagent never writes to the vault itself', () => {
    expect(qa).toMatch(/you never write to the vault yourself/i);
  });
});
