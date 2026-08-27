import { describe, expect, it } from 'vitest';
import { extractSubtaskPaths } from './plan-paths.js';

const PLAN = `# Plan: AUTH-12

## Subtasks

1. **implementer** — Fix login callback
   - files likely touched: \`src/auth/login.ts\`, \`src/auth/callback.ts\`
2. **tester** — Cover the callback
   - files likely touched: tests/auth.test.ts
3. **implementer** — Unrelated docs
   - files likely touched: <!-- list paths -->
`;

describe('extractSubtaskPaths', () => {
  it('reads files likely touched from numbered subtasks', () => {
    const items = extractSubtaskPaths(PLAN);
    expect(items).toEqual([
      {
        id: 'implementer: Fix login callback',
        paths: ['src/auth/callback.ts', 'src/auth/login.ts'],
      },
      { id: 'tester: Cover the callback', paths: ['tests/auth.test.ts'] },
    ]);
  });

  it('returns empty when there is no Subtasks section', () => {
    expect(extractSubtaskPaths('# Plan\n\n## Goal\n\nDo it.\n')).toEqual([]);
  });
});
