import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { detectRuleSources, readRuleExcerpts } from './rules.js';

describe('detectRuleSources', () => {
  it('finds rules across editors and repos, non-exclusively', async () => {
    const fs = new MemoryFilesystem({
      // repoA: Cursor rules (dir) + a legacy .cursorrules
      '/ws/api/.cursor/rules/style.mdc': '# style',
      '/ws/api/.cursor/rules/tests.md': '# tests',
      '/ws/api/.cursorrules': 'legacy',
      // repoB: Claude + Copilot
      '/ws/web/CLAUDE.md': '# claude rules',
      '/ws/web/.github/copilot-instructions.md': '# copilot',
      // workspace root: AGENTS.md
      '/ws/AGENTS.md': '# agents',
      // noise
      '/ws/api/src/index.ts': 'x',
    });

    const sources = await detectRuleSources(fs, '/ws', ['.', 'api', 'web']);
    const paths = sources.map((s) => s.path).sort();

    expect(paths).toEqual([
      'AGENTS.md',
      'api/.cursor/rules/style.mdc',
      'api/.cursor/rules/tests.md',
      'api/.cursorrules',
      'web/.github/copilot-instructions.md',
      'web/CLAUDE.md',
    ]);

    // editors are tagged, non-exclusive
    const editors = new Set(sources.map((s) => s.editor));
    expect(editors).toContain('Cursor');
    expect(editors).toContain('Claude Code');
    expect(editors).toContain('GitHub Copilot');
    expect(editors).toContain('Agents');
  });

  it('lists rule files inside a rules directory (.md/.mdc only)', async () => {
    const fs = new MemoryFilesystem({
      '/ws/.cursor/rules/a.mdc': 'a',
      '/ws/.cursor/rules/b.md': 'b',
      '/ws/.cursor/rules/notes.txt': 'ignored',
    });
    const sources = await detectRuleSources(fs, '/ws', ['.']);
    expect(sources.map((s) => s.path).sort()).toEqual([
      '.cursor/rules/a.mdc',
      '.cursor/rules/b.md',
    ]);
  });

  it('returns [] when no rules exist', async () => {
    const fs = new MemoryFilesystem({ '/ws/api/src/index.ts': 'x' });
    expect(await detectRuleSources(fs, '/ws', ['.', 'api'])).toEqual([]);
  });
});

describe('readRuleExcerpts', () => {
  it('reads fresh content and clamps per rule', async () => {
    const long = 'x'.repeat(1000);
    const fs = new MemoryFilesystem({
      '/ws/CLAUDE.md': `# Rules\n${long}`,
    });
    const sources = [{ repo: '.', editor: 'Claude Code', path: 'CLAUDE.md' }];
    const [ex] = await readRuleExcerpts(fs, '/ws', sources, { maxCharsPerRule: 50 });
    expect(ex?.excerpt.length).toBeLessThanOrEqual(50);
    expect(ex?.excerpt.startsWith('# Rules')).toBe(true);
  });

  it('respects the total budget across rules', async () => {
    const fs = new MemoryFilesystem({
      '/ws/a/CLAUDE.md': 'a'.repeat(500),
      '/ws/b/CLAUDE.md': 'b'.repeat(500),
      '/ws/c/CLAUDE.md': 'c'.repeat(500),
    });
    const sources = [
      { repo: 'a', editor: 'Claude Code', path: 'a/CLAUDE.md' },
      { repo: 'b', editor: 'Claude Code', path: 'b/CLAUDE.md' },
      { repo: 'c', editor: 'Claude Code', path: 'c/CLAUDE.md' },
    ];
    const excerpts = await readRuleExcerpts(fs, '/ws', sources, {
      maxCharsPerRule: 400,
      totalBudget: 500,
    });
    const totalChars = excerpts.reduce((n, e) => n + e.excerpt.length, 0);
    expect(totalChars).toBeLessThanOrEqual(500);
  });
});
