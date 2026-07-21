import { describe, expect, it } from 'vitest';
import { validatePlan } from './validator.js';

// A golden corpus: representative plans → a frozen snapshot of the heuristic
// verdict. This is the behaviour baseline for the reviewer — any change to the
// checks in validator.ts surfaces here as a snapshot diff, so nothing shifts
// silently. NO LLM: every verdict is mechanical. Update with `vitest -u` only
// when the behaviour change is intended.

const FIXTURES: Record<string, string> = {
  'backend-clean': `# Add a health check endpoint
## Acceptance criteria
- [ ] GET /health returns 200 and JSON status ok
- [ ] Tests cover the new endpoint
## Subtasks
1. **implementer** — Add the /health route in src/routes/health.ts
2. **tester** — Add a vitest test in src/routes/health.test.ts
## Risks
- none identified`,

  'frontend-no-qa': `## Acceptance criteria
- [ ] the React dashboard shows the new widget, with tests
## Subtasks
1. **implementer** — add the widget in src/components/Widget.tsx
2. **tester** — add vitest tests`,

  'mobile-visual-underspecified': `## Acceptance criteria
- [ ] the Expo profile screen matches the design, with tests
## Subtasks
1. **implementer** — build the screen in src/screens/Profile.tsx
2. **tester** — add vitest tests
## QA plan
- Seed a demo user, open Profile, confirm the name renders.

Reference: https://www.figma.com/file/abc/Profile?node-id=1-2`,

  'deletion-no-orphan': `## Acceptance criteria
- [ ] the legacy handler is removed, with tests
## Subtasks
1. **implementer** — delete the FutureFees handler in src/cases.ts
2. **tester** — add vitest tests`,

  'sensitive-no-risk': `## Acceptance criteria
- [ ] login enforces MFA, with tests
## Subtasks
1. **implementer** — update the auth flow in src/auth/login.ts
2. **tester** — add vitest tests`,

  'one-liner': 'implement a health check sin tests',

  'full-visual': `## Acceptance criteria
- [ ] the settings screen matches the design, with tests
## Design
- Figma: https://www.figma.com/file/abc/Settings?node-id=3-4
- Frames: Settings/Default; breakpoints 375/1024; states default, error.
## Subtasks
1. **implementer** — build the screen in src/screens/Settings.tsx
2. **tester** — add vitest tests
## QA plan
- Target: iOS simulator (iPhone 15) via expo start.
- **Given** a logged-in user, **When** they open Settings, **Then** it renders per the design.
## Risks
- none identified`,
};

function verdict(plan: string): Record<string, unknown> {
  const r = validatePlan({ plan, task: 'golden' });
  return {
    issues: r.issues.map((i) => `${i.severity}:${i.code}`).sort(),
    riskFlags: r.riskFlags.length,
    suggestions: r.suggestions.length,
  };
}

describe('validatePlan — golden verdicts', () => {
  it('matches the frozen reviewer baseline across the corpus', () => {
    const golden = Object.fromEntries(
      Object.entries(FIXTURES).map(([name, plan]) => [name, verdict(plan)]),
    );
    expect(golden).toMatchInlineSnapshot(`
      {
        "backend-clean": {
          "issues": [],
          "riskFlags": 0,
          "suggestions": 0,
        },
        "deletion-no-orphan": {
          "issues": [
            "warning:deletion-without-orphan-check",
          ],
          "riskFlags": 0,
          "suggestions": 1,
        },
        "frontend-no-qa": {
          "issues": [
            "warning:missing-qa-plan",
          ],
          "riskFlags": 0,
          "suggestions": 1,
        },
        "full-visual": {
          "issues": [],
          "riskFlags": 0,
          "suggestions": 0,
        },
        "mobile-visual-underspecified": {
          "issues": [
            "warning:missing-design-capture",
            "warning:mobile-qa-missing-target",
            "warning:qa-criteria-not-testable",
          ],
          "riskFlags": 0,
          "suggestions": 3,
        },
        "one-liner": {
          "issues": [
            "error:no-acceptance-criteria",
            "error:no-subtasks",
            "error:no-tests",
          ],
          "riskFlags": 0,
          "suggestions": 2,
        },
        "sensitive-no-risk": {
          "issues": [
            "error:missing-risk-assessment",
          ],
          "riskFlags": 1,
          "suggestions": 1,
        },
      }
    `);
  });
});
