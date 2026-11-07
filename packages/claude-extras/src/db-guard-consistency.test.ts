/**
 * db-guard-consistency.test.ts — ST-11 (drift test)
 *
 * Verifies bidirectional consistency between the CHAMBA-013 hook
 * (PreToolUse-warn-destructive.sh) and DB_WIPE_TOKENS in @chamba/core.
 *
 * PRIMARY direction (hook → core):
 *   Extract every *"TOKEN"* pattern from the hook's database-wipe case block
 *   and assert each one is present in DB_WIPE_TOKENS. This guarantees that
 *   adding a new pattern to the hook without updating core FAILS this test.
 *
 * SECONDARY direction (core → hook):
 *   Every token in DB_WIPE_TOKENS must appear as a substring of the hook file.
 *   This guarantees that adding a token to core without updating the hook also fails.
 *
 * No bash execution — text search only. Cross-platform (macOS/Windows/Linux).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DB_WIPE_TOKENS } from '@chamba/core';
import { describe, expect, it } from 'vitest';

function hookPath(): string {
  return fileURLToPath(new URL('../assets/hooks/PreToolUse-warn-destructive.sh', import.meta.url));
}

function readHook(): string {
  return readFileSync(hookPath(), 'utf8');
}

/**
 * Extract the tokens from the hook's database-wipe case block.
 * Finds the section after the "# Database wipes" comment and reads only
 * the first `case ... esac` block within it.
 *
 * Example case arm line:
 *   *"migrate reset"*|*"--force-reset"*|...
 * → returns ["migrate reset", "--force-reset", ...]
 */
function extractHookDbWipeTokens(hookText: string): string[] {
  // Find the database-wipe section (marked by "# Database wipes" comment)
  const afterMarker = hookText.split('# Database wipes')[1];
  if (!afterMarker) return [];

  // Limit to the first case block by finding the first `esac`
  const esacIdx = afterMarker.indexOf('esac');
  if (esacIdx === -1) return [];
  const firstCaseBlock = afterMarker.slice(0, esacIdx);

  // Extract all *"TOKEN"* patterns: matches the content inside *"..."*
  const tokens: string[] = [];
  const tokenPattern = /\*"([^"]+)"\*/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
  while ((match = tokenPattern.exec(firstCaseBlock)) !== null) {
    if (match[1] !== undefined) {
      tokens.push(match[1]);
    }
  }
  return tokens;
}

describe('DB guard consistency — hook vs DB_WIPE_TOKENS (CHAMBA-013)', () => {
  const hookText = readHook();
  const hookTokens = extractHookDbWipeTokens(hookText);

  it('hook file is readable and non-empty', () => {
    expect(hookText.length).toBeGreaterThan(0);
  });

  it('hook contains a database-wipe case block', () => {
    expect(hookText).toContain('Database wipes');
  });

  it('extracts at least one DB-wipe token from hook', () => {
    expect(hookTokens.length).toBeGreaterThan(0);
  });

  it('DB_WIPE_TOKENS is non-empty', () => {
    expect(DB_WIPE_TOKENS.length).toBeGreaterThan(0);
  });

  // PRIMARY direction: hook → core
  // For each token the hook guards, core must know about it.
  // If a new pattern is added to the hook without updating core, this fails.
  describe('PRIMARY: every hook token is in DB_WIPE_TOKENS (hook → core)', () => {
    for (const token of hookTokens) {
      it(`hook token "${token}" is covered by DB_WIPE_TOKENS`, () => {
        expect(
          DB_WIPE_TOKENS,
          `Hook guards against "${token}" but DB_WIPE_TOKENS in @chamba/core does not include it. ` +
            `Add "${token}" to packages/core/src/routing/risk-terms.ts → DB_WIPE_TOKENS.`,
        ).toContain(token);
      });
    }
  });

  // SECONDARY direction: core → hook
  // For each token exported from core, the hook must contain it as a substring.
  // If a token is added to core without updating the hook, this fails.
  describe('SECONDARY: every DB_WIPE_TOKEN appears in hook (core → hook)', () => {
    for (const token of DB_WIPE_TOKENS) {
      it(`DB_WIPE_TOKEN "${token}" appears in PreToolUse-warn-destructive.sh`, () => {
        expect(
          hookText,
          `DB_WIPE_TOKEN "${token}" is in @chamba/core but not found in PreToolUse-warn-destructive.sh. ` +
            `Either add it to the hook's database-wipe case or remove it from DB_WIPE_TOKENS.`,
        ).toContain(token);
      });
    }
  });
});
