/**
 * commands-consistency.test.ts — verifies that every subcommand found in
 * `assets/commands/*.md` (via headings or `argument-hint`) is in the
 * approved English-only allow-list (CHAMBA-019).
 *
 * Two extraction sources (and only these, so deprecated aliases in prose are
 * not flagged):
 *   (a) Headings: `^## \`/<cmd> <sub>\`` — captures <sub>
 *   (b) argument-hint: first alternation group before any free-form placeholder,
 *       first word of each option; skips tokens that contain < > = . or start
 *       with - or are "..."
 *
 * Also hardens vault.md: every line containing "iniciar" or "clasificar" must
 * also contain "deprecad" — ensures the Spanish aliases live only in the
 * compatibility preamble.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// All English subcommands that exist today (after CHAMBA-019 rename).
// Excludes "iniciar" and "clasificar" deliberately — the test fails if either
// appears as a heading subcommand or in an argument-hint.
const ALLOWED = new Set([
  'status',
  'init',
  'classify',
  'reindex',
  'show',
  'reload',
  'list',
  'preview',
  'cleanup',
  'sync',
  'join',
  'link',
  'resync',
  'unlink',
  'prefs',
  'en',
  'es',
]);

const commandsDir = fileURLToPath(new URL('../assets/commands', import.meta.url));

function readCommand(name: string): string {
  return readFileSync(join(commandsDir, name), 'utf8');
}

function listCommandFiles(): string[] {
  return readdirSync(commandsDir).filter((f) => f.endsWith('.md'));
}

/** Extract subcommands from headings of the form:  ## `/cmd sub` */
function extractHeadingSubcommands(content: string): string[] {
  const results: string[] = [];
  // Match: ## `/<word> <sub>` where sub is a single word
  const re = /^## `\/\w+ ([a-z][a-z-]*)`/gm;
  for (const m of content.matchAll(re)) {
    if (m[1] !== undefined) results.push(m[1]);
  }
  return results;
}

/**
 * Extract subcommands from the first alternation group in `argument-hint`.
 * Handles both `[a|b|c]` and `a | b | c` forms.
 * Skips tokens that: contain < > = . , start with -, or are "..."
 */
function extractArgumentHintSubcommands(content: string): string[] {
  // Parse argument-hint from frontmatter
  const hintMatch = content.match(/^argument-hint:\s*"?(.+?)"?\s*$/m);
  if (!hintMatch) return [];

  const hint = (hintMatch[1] ?? '').trim();

  // Grab first bracketed group if present: [a|b|c]
  const bracketMatch = hint.match(/^\[([^\]]+)\]/);
  const rawGroup = bracketMatch ? (bracketMatch[1] ?? hint) : hint;

  // Split on | to get options; take only part before any free-form args
  const options = rawGroup.split('|').map((s) => s.trim());

  const results: string[] = [];
  for (const opt of options) {
    // Take first word only (before space)
    const word = opt.split(/\s+/)[0];
    if (!word) continue;
    // Skip tokens with special chars or flags
    if (/[<>=.]/.test(word)) continue;
    if (word.startsWith('-')) continue;
    if (word === '...') continue;
    // Must look like a subcommand
    if (/^[a-z][a-z-]*$/.test(word)) {
      results.push(word);
    }
  }
  return results;
}

describe('commands-consistency (CHAMBA-019)', () => {
  const files = listCommandFiles();

  it('found command files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const content = readCommand(file);
    const headingSubs = extractHeadingSubcommands(content);
    const hintSubs = extractArgumentHintSubcommands(content);
    const allSubs = [...headingSubs, ...hintSubs];

    if (allSubs.length === 0) continue;

    describe(`${file}`, () => {
      for (const sub of allSubs) {
        it(`subcommand "${sub}" is in the English allow-list`, () => {
          expect(
            ALLOWED.has(sub),
            `"${sub}" found in ${file} is not in ALLOWED; if it is a new English subcommand add it to ALLOWED; if it is a Spanish alias it must stay only in prose body, not in headings or argument-hint`,
          ).toBe(true);
        });
      }
    });
  }

  describe('vault.md — deprecated aliases hardening', () => {
    const vaultContent = readCommand('vault.md');
    const lines = vaultContent.split('\n');

    // Only check for the command forms `/vault iniciar` and `/vault clasificar`,
    // NOT the data-contract strings like `sin-clasificar.md` or the verb "clasificar".
    const commandPatterns: Array<{ dep: string; re: RegExp }> = [
      { dep: '/vault iniciar', re: /\/vault iniciar/ },
      { dep: '/vault clasificar', re: /\/vault clasificar/ },
    ];

    for (const { dep, re } of commandPatterns) {
      const matchingLines = lines.filter((l) => re.test(l));
      for (const line of matchingLines) {
        it(`line containing "${dep}" also mentions "deprecad": ${line.trim().slice(0, 80)}`, () => {
          expect(
            line,
            `Line contains "${dep}" but does not mention "deprecad" — Spanish command aliases must only appear in the compatibility preamble with a deprecation notice`,
          ).toMatch(/deprecad/i);
        });
      }
    }
  });
});
