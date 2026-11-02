/**
 * agents-perf.test.ts — verifies that the agent prompt files contain the
 * performance/concurrency keywords added in CHAMBA-012 (AC2, AC3, AC6).
 *
 * Reads the real asset files via import.meta.url so the tests travel with the
 * source tree without hard-coding absolute paths.
 *
 * Depth from this file to assets: ../assets/agents/<x>.md
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function agentPath(name: string): string {
  return fileURLToPath(new URL(`../assets/agents/${name}.md`, import.meta.url));
}

function read(name: string): string {
  return readFileSync(agentPath(name), 'utf8');
}

// ---------------------------------------------------------------------------
// AC3 — the 33 original lines of implementer.md must all still be present
// in the same order (ordered-subsequence check). Any additive change is fine;
// a deletion or rewrite of an original line must fail this test.
// ---------------------------------------------------------------------------
const ORIGINAL_IMPLEMENTER_LINES = [
  '---',
  'name: implementer',
  'description: Implements a single, well-scoped coding subtask from a reviewed plan',
  '---',
  '',
  'You are the **implementer**. You receive one concrete subtask from a plan that',
  'has already been reviewed and approved.',
  '',
  '- Implement exactly that subtask — no scope creep. If the task is ambiguous or',
  '  bigger than described, stop and report back instead of guessing.',
  '- **Never delete or destroy without asking.** Dropping/resetting/truncating a',
  '  database, wiping data, deleting files, force-pushing, deleting branches, or',
  '  removing container/cloud resources (`prisma migrate reset`, `db push',
  '  --force-reset`/`--accept-data-loss`, `DROP`/`TRUNCATE`, `rm -rf`, `git branch -D`,',
  '  `git reset --hard`, `docker … down -v`) is off-limits unless I explicitly confirm.',
  '  If a step seems to need it, STOP and ask first.',
  "- Match the surrounding code's style, naming and conventions.",
  '- **If the subtask has design references** (a `## Design` section or a Figma link):',
  '  when a **Figma MCP** is configured, pull the exact tokens, measurements, typography and',
  '  spacing from the referenced frames/nodes and build to them; without it, work from the',
  '  mockups + the written specs. If the design source links a **standalone prototype** (an',
  '  `.html` or `.zip` that `chamba_load_design` reported), **open/run it** as the behavioural',
  "  target — match its layout and interactions. chamba doesn't call Figma — your editor's",
  '  Figma MCP does. Aim for **design-accurate**; never claim pixel-perfect.',
  '- **Follow the saved UI architecture.** Build to the methodology in `chamba_design_prefs`',
  '  (`web` or, for an Expo/React Native app, `mobile`) — e.g. atoms/molecules/organisms for',
  '  Atomic Design, or screens+components for a mobile app. Match the existing folder structure',
  "  and component granularity; don't invent a different architecture.",
  '- If you were given a git worktree path, do all your edits there; never touch',
  '  files outside your assigned worktree.',
  "- Do not write tests (that's the tester's job) unless the subtask explicitly says so.",
  '- When done, report: what you changed, the files touched, and anything the tester',
  '  or reviewer should know.',
];

describe('implementer.md', () => {
  let content: string;
  let lines: string[];

  it('loads without error', () => {
    content = read('implementer');
    lines = content.split('\n');
    expect(lines.length).toBeGreaterThan(0);
  });

  it('contains Performance & concurrency section (AC2)', () => {
    content = content ?? read('implementer');
    expect(content).toContain('Performance & concurrency');
  });

  it('contains bounded (AC2)', () => {
    expect(read('implementer')).toContain('bounded');
  });

  it('contains idempotent (AC2)', () => {
    expect(read('implementer')).toContain('idempotent');
  });

  it('contains timeout (AC2)', () => {
    expect(read('implementer')).toContain('timeout');
  });

  it('contains hot-path (AC2)', () => {
    expect(read('implementer')).toContain('hot-path');
  });

  it('contains Perf/concurrency notes (AC2)', () => {
    expect(read('implementer')).toContain('Perf/concurrency notes');
  });

  it('contains measure before you optimize (AC6)', () => {
    expect(read('implementer')).toContain('measure before you optimize');
  });

  it('total lines <= 58 — diff is additive, not a rewrite (AC3)', () => {
    const actual = read('implementer').split('\n');
    expect(actual.length).toBeLessThanOrEqual(58);
  });

  it('all 33 original lines still present in order — ordered-subsequence check (AC3)', () => {
    const actualLines = read('implementer').split('\n');
    let cursor = 0;
    for (const expected of ORIGINAL_IMPLEMENTER_LINES) {
      const idx = actualLines.indexOf(expected, cursor);
      expect(idx, `original line not found: ${JSON.stringify(expected)}`).toBeGreaterThanOrEqual(
        cursor,
      );
      cursor = idx + 1;
    }
  });
});

describe('reviewer.md', () => {
  it('contains timeout (AC2)', () => {
    expect(read('reviewer')).toContain('timeout');
  });

  it('contains hot-path (AC2)', () => {
    expect(read('reviewer')).toContain('hot-path');
  });

  it('contains race condition (AC2)', () => {
    expect(read('reviewer')).toContain('race condition');
  });

  it('contains micro-optimization (AC6)', () => {
    expect(read('reviewer')).toContain('micro-optimization');
  });

  it('contains bounded (AC2)', () => {
    expect(read('reviewer')).toContain('bounded');
  });

  it('contains never gate on them (AC6)', () => {
    expect(read('reviewer')).toContain('never gate on them');
  });
});

describe('planner.md', () => {
  it('contains hot-path (AC2)', () => {
    expect(read('planner')).toContain('hot-path');
  });

  it("contains don't invent them (AC6)", () => {
    expect(read('planner')).toContain("don't invent them");
  });
});

describe('tester.md', () => {
  it('contains hot-path (AC2)', () => {
    expect(read('tester')).toContain('hot-path');
  });

  it('contains concurrency (AC2)', () => {
    expect(read('tester')).toContain('concurrency');
  });

  it('contains bounded (AC2)', () => {
    expect(read('tester')).toContain('bounded');
  });
});
