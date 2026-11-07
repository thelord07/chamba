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

describe('cursor-extras copy-assets — agent files', () => {
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

describe('cursor-extras copy-assets — navigate before reading (CHAMBA-017)', () => {
  it('planner.md copy contains chamba_vault_navigate', () => {
    expect(readCopy('planner')).toContain('chamba_vault_navigate');
  });
});

// ── CHAMBA-020: routing in command files ───────────────────────────────────────

function commandCopyPath(name: string): string {
  return fileURLToPath(new URL(`../assets/commands/${name}.md`, import.meta.url));
}

function commandSourcePath(name: string): string {
  return fileURLToPath(new URL(`../../claude-extras/assets/commands/${name}.md`, import.meta.url));
}

function readCommandCopy(name: string): string {
  return readFileSync(commandCopyPath(name), 'utf8');
}

const COMMANDS = ['ticket', 'orq'] as const;
const FOUR_ROUTES = ['trivial', 'small', 'substantial', 'risky'] as const;

describe('cursor-extras copy-assets — command files (CHAMBA-020)', () => {
  for (const cmd of COMMANDS) {
    describe(`${cmd}.md`, () => {
      it('is byte-identical to the claude-extras source', () => {
        const source = readFileSync(commandSourcePath(cmd), 'utf8');
        expect(readCommandCopy(cmd)).toBe(source);
      });

      for (const route of FOUR_ROUTES) {
        it(`contains route "${route}"`, () => {
          expect(readCommandCopy(cmd)).toContain(route);
        });
      }

      it('contains "máx. 2 rondas"', () => {
        expect(readCommandCopy(cmd)).toContain('máx. 2 rondas');
      });

      it('does not contain "6 rounds"', () => {
        expect(readCommandCopy(cmd)).not.toContain('6 rounds');
      });
    });
  }
});
