import { describe, expect, it } from 'vitest';
import type { Workspace } from '../workspace/workspace.js';
import { validatePlan } from './validator.js';

const codes = (plan: string, workspace?: Workspace) =>
  validatePlan({ plan, task: 't', workspace }).issues.map((i) => i.code);

const GOOD_PLAN = `# Plan: add a health check endpoint

## Goal
Expose GET /health returning 200 with uptime.

## Acceptance criteria
- [ ] GET /health returns 200 and JSON status ok
- [ ] Tests cover the new endpoint

## Subtasks
1. **implementer** — Add the /health route handler in src/routes/health.ts
2. **tester** — Add a vitest test in src/routes/health.test.ts

## Risks
- none identified

## Files likely touched
- src/routes/health.ts
`;

describe('validatePlan', () => {
  it('passes a complete, well-structured plan with no errors', () => {
    const result = validatePlan({ plan: GOOD_PLAN, task: 'add health check' });
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('flags a one-liner plan with multiple errors', () => {
    expect(codes('implementar health check sin tests')).toEqual(
      expect.arrayContaining(['no-acceptance-criteria', 'no-tests', 'no-subtasks']),
    );
  });

  it('detects missing tests', () => {
    const plan = `## Acceptance criteria
- [ ] GET /health returns 200

## Subtasks
1. **implementer** — add route in src/health.ts`;
    expect(codes(plan)).toContain('no-tests');
  });

  it('detects subtasks without an assigned worker', () => {
    const plan = `## Acceptance criteria
- [ ] does X

## Subtasks
1. Build the thing in src/x.ts
2. Add tests in src/x.test.ts`;
    expect(codes(plan)).toContain('subtask-without-worker');
  });

  it('detects a vague (placeholder) subtask as a warning', () => {
    const plan = `## Acceptance criteria
- [ ] does X with tests

## Subtasks
1. **implementer** — TODO
2. **tester** — add vitest tests for the feature behaviour`;
    const result = validatePlan({ plan, task: 't' });
    expect(result.issues.map((i) => i.code)).toContain('vague-subtask');
    // warning only → still no error-severity issues
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('flags files outside the known workspace modules', () => {
    const workspace: Workspace = {
      root: '/r',
      description: 'x',
      languages: ['TypeScript'],
      conventions: [],
      ruleSources: [],
      projects: [{ name: 'r', path: '.' }],
      folderMap: ['src'],
    };
    const plan = `## Acceptance criteria
- [ ] does X with tests

## Subtasks
1. **implementer** — edit weird/thing.ts
2. **tester** — add vitest tests`;
    const result = validatePlan({ plan, task: 't', workspace });
    expect(result.riskFlags.join(' ')).toContain('weird/thing.ts');
  });

  it('requires a risk assessment when touching a sensitive area', () => {
    const plan = `## Acceptance criteria
- [ ] includes tests

## Subtasks
1. **implementer** — update src/auth/login.ts
2. **tester** — add vitest tests`;
    expect(codes(plan)).toContain('missing-risk-assessment');
  });

  it('warns when a plan deletes code without a referential-closure check', () => {
    const plan = `## Acceptance criteria
- [ ] feature removed, with tests

## Subtasks
1. **implementer** — delete the FutureFeesReview handler in src/cases.ts
2. **tester** — add vitest tests`;
    const result = validatePlan({ plan, task: 't' });
    const issue = result.issues.find((i) => i.code === 'deletion-without-orphan-check');
    expect(issue?.severity).toBe('warning');
  });

  it('does not warn when the deletion plan checks for orphans', () => {
    const plan = `## Acceptance criteria
- [ ] feature removed, with tests

## Subtasks
1. **implementer** — remove the handler in src/cases.ts
2. **implementer** — run knip and typecheck to confirm no orphaned exports remain
3. **tester** — add vitest tests`;
    expect(codes(plan)).not.toContain('deletion-without-orphan-check');
  });

  it('does not warn for a plan that adds code (no deletion)', () => {
    expect(codes(GOOD_PLAN)).not.toContain('deletion-without-orphan-check');
  });

  it('warns when the plan has unresolved open questions', () => {
    const plan = `## Acceptance criteria
- [ ] does X with tests

## Subtasks
1. **implementer** — build X in src/x.ts
2. **tester** — add vitest tests

## Open questions
- Should non-USD mismatches also stop the manual email path?`;
    const result = validatePlan({ plan, task: 't' });
    const issue = result.issues.find((i) => i.code === 'unresolved-open-questions');
    expect(issue?.severity).toBe('warning');
  });

  it('does not warn when open questions are marked resolved', () => {
    const plan = `## Acceptance criteria
- [ ] does X with tests

## Subtasks
1. **implementer** — build X in src/x.ts
2. **tester** — add vitest tests

## Open questions
- Should non-USD mismatches stop the manual email path? → No, keep manual email.`;
    expect(codes(plan)).not.toContain('unresolved-open-questions');
  });

  it('does not warn for a plan without open questions', () => {
    expect(codes(GOOD_PLAN)).not.toContain('unresolved-open-questions');
  });

  it('warns when a user-facing plan has no QA plan', () => {
    const plan = `## Acceptance criteria
- [ ] the React dashboard shows the new widget, with tests

## Subtasks
1. **implementer** — add the widget in src/components/Widget.tsx
2. **tester** — add vitest tests`;
    const result = validatePlan({ plan, task: 't' });
    const issue = result.issues.find((i) => i.code === 'missing-qa-plan');
    expect(issue?.severity).toBe('warning');
  });

  it('does not warn when a user-facing plan includes a QA plan', () => {
    const plan = `## Acceptance criteria
- [ ] the React dashboard shows the new widget, with tests

## Subtasks
1. **implementer** — add the widget in src/components/Widget.tsx
2. **tester** — add vitest tests

## QA plan
- Seed a demo user, log in at /dashboard, confirm the widget renders.`;
    expect(codes(plan)).not.toContain('missing-qa-plan');
  });

  it('does not warn for a backend-only plan', () => {
    expect(codes(GOOD_PLAN)).not.toContain('missing-qa-plan');
  });

  it('warns when a QA plan has criteria not in Given/When/Then form', () => {
    const plan = `## Acceptance criteria
- [ ] the dashboard shows the widget, with tests

## Subtasks
1. **implementer** — add the widget in src/components/Widget.tsx
2. **tester** — add vitest tests

## QA plan
- Seed a demo user, log in at /dashboard, confirm the widget renders.`;
    const issue = validatePlan({ plan, task: 't' }).issues.find(
      (i) => i.code === 'qa-criteria-not-testable',
    );
    expect(issue?.severity).toBe('warning');
  });

  it('does not warn when the QA plan uses Given/When/Then', () => {
    const plan = `## Acceptance criteria
- [ ] the dashboard shows the widget, with tests

## Subtasks
1. **implementer** — add the widget in src/components/Widget.tsx
2. **tester** — add vitest tests

## QA plan
- **Given** a logged-in demo user, **When** they open /dashboard, **Then** the new widget renders with today's totals.`;
    expect(codes(plan)).not.toContain('qa-criteria-not-testable');
  });

  it('accepts Spanish Dado/Cuando/Entonces in the QA plan', () => {
    const plan = `## Acceptance criteria
- [ ] el tablero muestra el widget, con tests

## Subtasks
1. **implementer** — agregá el widget en src/components/Widget.tsx
2. **tester** — agregá tests de vitest

## QA plan
- **Dado** un usuario logueado, **Cuando** abre /dashboard, **Entonces** el widget renderiza los totales de hoy.`;
    expect(codes(plan)).not.toContain('qa-criteria-not-testable');
  });

  it('does not raise the G/W/T warning for a backend-only plan', () => {
    expect(codes(GOOD_PLAN)).not.toContain('qa-criteria-not-testable');
  });
});
