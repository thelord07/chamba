import { describe, expect, it } from 'vitest';
import { Reviewer } from './reviewer.js';

const reviewer = new Reviewer();

const GOOD_PLAN = `## Acceptance criteria
- [ ] GET /health returns 200
- [ ] Tests cover it

## Subtasks
1. **implementer** — add src/health.ts
2. **tester** — add vitest test in src/health.test.ts`;

describe('Reviewer', () => {
  it('approves a plan with no error-severity issues', () => {
    const review = reviewer.review({ plan: GOOD_PLAN, task: 'health check' });
    expect(review.approved).toBe(true);
  });

  it('rejects a plan that is missing tests', () => {
    const plan = `## Acceptance criteria
- [ ] GET /health returns 200

## Subtasks
1. **implementer** — add src/health.ts`;
    const review = reviewer.review({ plan, task: 'health check' });
    expect(review.approved).toBe(false);
    expect(review.issues.map((i) => i.code)).toContain('no-tests');
  });

  it('approves despite warnings (does not block on vague subtasks)', () => {
    const plan = `## Acceptance criteria
- [ ] does X with tests

## Subtasks
1. **implementer** — TODO
2. **tester** — add vitest tests for the behaviour`;
    const review = reviewer.review({ plan, task: 't' });
    expect(review.approved).toBe(true);
    expect(review.issues.some((i) => i.severity === 'warning')).toBe(true);
  });
});
