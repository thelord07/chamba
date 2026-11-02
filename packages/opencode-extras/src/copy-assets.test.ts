/**
 * copy-assets.test.ts — verifies that `scripts/copy-assets.mjs` has copied the
 * agent prompt files verbatim from `@chamba/claude-extras` into this package's
 * `assets/agents/` directory (AC4).
 *
 * The test `scripts/` in this package's `test` npm script runs copy-assets
 * before vitest, so by the time these tests run the files are already present.
 *
 * Depth from this file to the two assets directories:
 *   ../assets/agents/<x>.md                        (this package's copy)
 *   ../../claude-extras/assets/agents/<x>.md       (canonical source)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const AGENTS = ['implementer', 'reviewer', 'planner', 'tester'] as const;

function copyPath(name: string): string {
  return fileURLToPath(new URL(`../assets/agents/${name}.md`, import.meta.url));
}

function sourcePath(name: string): string {
  return fileURLToPath(new URL(`../../claude-extras/assets/agents/${name}.md`, import.meta.url));
}

function readCopy(name: string): string {
  return readFileSync(copyPath(name), 'utf8');
}

function readSource(name: string): string {
  return readFileSync(sourcePath(name), 'utf8');
}

describe('opencode-extras copy-assets — agent files', () => {
  for (const agent of AGENTS) {
    describe(`${agent}.md`, () => {
      it('is byte-identical to the claude-extras source (AC4)', () => {
        expect(readCopy(agent)).toBe(readSource(agent));
      });

      it('contains hot-path (AC4)', () => {
        expect(readCopy(agent)).toContain('hot-path');
      });
    });
  }

  it('implementer.md contains Performance & concurrency (AC4)', () => {
    expect(readCopy('implementer')).toContain('Performance & concurrency');
  });
});
