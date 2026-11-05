import { describe, expect, it } from 'vitest';
import { renderIndexNote } from '../obsidian/vault-index.js';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { ContextBuilder } from './context-builder.js';
import type { Workspace } from './workspace.js';

// Minimal chamba-generated root INDEX.md content (source: chamba is enough for INDEX.md)
const GENERATED_INDEX = '---\ntitle: "Index"\nsource: chamba\n---\n# Index\n';

const workspace: Workspace = {
  root: '/proj',
  description: 'A tiny HTTP API.',
  languages: ['TypeScript'],
  framework: 'Express',
  conventions: [],
  projects: [{ name: 'proj', path: '.', language: 'TypeScript' }],
  ruleSources: [],
  folderMap: ['src'],
};

describe('ContextBuilder', () => {
  it('includes a workspace section even without a vault', async () => {
    const builder = new ContextBuilder(new MemoryFilesystem({}));
    const built = await builder.build({ workspace, task: 'add a health check' });

    expect(built.context).toContain('## Workspace context');
    expect(built.context).toContain('A tiny HTTP API.');
    expect(built.relevantNotes).toEqual([]);
  });

  it('surfaces vault notes relevant to the task by keyword', async () => {
    const fs = new MemoryFilesystem({
      '/v/.obsidian/app.json': '{}',
      '/v/auth.md': '# Auth\n\nWe use magic links for authentication via Resend.\n',
      '/v/cooking.md': '# Cooking\n\nUnrelated notes about pasta.\n',
    });
    const built = await new ContextBuilder(fs).build({
      workspace,
      task: 'add authentication with magic links',
      vaultPath: '/v',
    });

    expect(built.relevantNotes).toEqual(['/v/auth.md']);
    expect(built.context).toContain('## Relevant notes');
    expect(built.context).toContain('auth.md');
  });

  it('uses the folder index first, then reads only the matched note', async () => {
    const fs = new MemoryFilesystem({
      '/v/.obsidian/app.json': '{}',
      '/v/proyectos/INDEX.md': renderIndexNote('proyectos', [
        { title: 'Auth', path: '2026-06-09-auth.md', description: 'magic links authentication' },
      ]),
      '/v/proyectos/2026-06-09-auth.md': '# Auth\n\nWe use magic links.\n',
    });
    const built = await new ContextBuilder(fs).build({
      workspace,
      task: 'add authentication',
      vaultPath: '/v',
    });
    expect(built.relevantNotes).toEqual(['/v/proyectos/2026-06-09-auth.md']);
  });

  it('falls back to a full scan when the index does not match', async () => {
    const fs = new MemoryFilesystem({
      '/v/.obsidian/app.json': '{}',
      '/v/proyectos/INDEX.md': renderIndexNote('proyectos', [
        { title: 'Cooking', path: 'cooking.md', description: 'pasta recipes' },
      ]),
      '/v/proyectos/cooking.md': '# Cooking\n\npasta\n',
      '/v/notes/deploy.md': '# Deploy\n\nKubernetes rollout strategy.\n',
    });
    const built = await new ContextBuilder(fs).build({
      workspace,
      task: 'kubernetes rollout',
      vaultPath: '/v',
    });
    expect(built.relevantNotes).toEqual(['/v/notes/deploy.md']);
  });

  it('clamps the context to the configured size', async () => {
    const builder = new ContextBuilder(new MemoryFilesystem({}));
    const built = await builder.build({ workspace, task: 'x', maxTokens: 5 });
    expect(built.context.length).toBeLessThanOrEqual(5 * 4);
  });

  it('includes a coding rules section with fresh excerpts, non-exclusive', async () => {
    const fs = new MemoryFilesystem({
      '/proj/api/.cursor/rules/style.mdc': '# Cursor style\nUse named exports.',
      '/proj/web/CLAUDE.md': '# Claude rules\nMatch surrounding code.',
    });
    const ws: Workspace = {
      ...workspace,
      ruleSources: [
        { repo: 'api', editor: 'Cursor', path: 'api/.cursor/rules/style.mdc' },
        { repo: 'web', editor: 'Claude Code', path: 'web/CLAUDE.md' },
      ],
    };
    const built = await new ContextBuilder(fs).build({ workspace: ws, task: 'anything' });

    expect(built.context).toContain('## Coding rules');
    expect(built.context).toContain('api/.cursor/rules/style.mdc');
    expect(built.context).toContain('Use named exports.');
    expect(built.context).toContain('web/CLAUDE.md');
    expect(built.context).toContain('Match surrounding code.');
  });

  it('skips the rules section when includeRules is false', async () => {
    const fs = new MemoryFilesystem({ '/proj/CLAUDE.md': '# rules' });
    const ws: Workspace = {
      ...workspace,
      ruleSources: [{ repo: '.', editor: 'Claude Code', path: 'CLAUDE.md' }],
    };
    const built = await new ContextBuilder(fs).build({
      workspace: ws,
      task: 'x',
      includeRules: false,
    });
    expect(built.context).not.toContain('## Coding rules');
  });

  /**
   * Test 7 — map mode: note set must not include INDEX.md or temas/* paths.
   */
  it('mapa mode: note set excludes INDEX.md files and temas/* paths', async () => {
    const fs = new MemoryFilesystem({
      // Root INDEX.md must be chamba-generated to trigger mapa mode
      '/vault/INDEX.md': GENERATED_INDEX,
      // Vocabulary (required for scoring)
      '/vault/temas/VOCABULARIO.md': [
        '---',
        'title: "Vocab"',
        'source: human',
        'umbral_promover: 3',
        'umbral_dividir: 25',
        '---',
        '# Vocab',
        '- `api` — API notes.',
      ].join('\n'),
      // A temas/ hub that must NOT appear in mapa notes
      '/vault/temas/api.md': '# API hub\n',
      // A real note that may appear
      '/vault/proyectos/nota.md': [
        '---',
        'title: "Nota API"',
        'type: proyecto',
        'tags: [tema/api]',
        'keywords: [api, endpoint]',
        '---',
        '# Nota API\n',
      ].join('\n'),
      // A folder INDEX.md that must NOT appear in mapa notes
      '/vault/proyectos/INDEX.md': renderIndexNote('proyectos', [
        { title: 'Nota API', path: 'nota.md', description: 'nota api' },
      ]),
    });

    const built = await new ContextBuilder(fs).build({
      workspace,
      task: 'endpoint api',
      vaultPath: '/vault',
    });

    // Must be mapa mode
    expect(built.context).toContain('## Mapa del vault');
    expect(built.mapa).toBeDefined();

    // All note paths in mapa must not be INDEX.md or under temas/
    if (built.mapa) {
      const allPaths = [
        ...built.mapa.nodos.flatMap((n) => n.notas.map((note) => note.ruta)),
        ...built.mapa.workItems.flatMap((wi) => wi.notas.map((n) => n.ruta)),
      ];
      for (const p of allPaths) {
        expect(p).not.toMatch(/\/INDEX\.md$|^INDEX\.md$/);
        expect(p).not.toMatch(/^temas\//);
      }
    }
  });

  /**
   * Test 8 — reglasRecortadas: when workspace+mapa+rules overflow the budget,
   * the context keeps partial content + notice, total ≤ maxChars, map section intact.
   *
   * readRuleExcerpts clamps each file to 400 chars by default.  So the rules section
   * is ~500 chars (excerpt + header).  Combined with workspace (~108) and mapa
   * (~160 minimum), full ≈ 770 chars.  Using maxTokens=150 (maxChars=600) triggers
   * the overflow: 770 > 600.
   */
  it('reglasRecortadas: big rules keep partial rules + notice, total ≤ maxChars', async () => {
    const fs = new MemoryFilesystem({
      '/vault/INDEX.md': GENERATED_INDEX,
      '/vault/temas/VOCABULARIO.md': [
        '---',
        'title: "Vocab"',
        'source: human',
        'umbral_promover: 3',
        'umbral_dividir: 25',
        '---',
        '# Vocab',
        '- `api` — API notes.',
      ].join('\n'),
      '/vault/proyectos/nota.md': [
        '---',
        'title: "Nota API"',
        'type: proyecto',
        'tags: [tema/api]',
        'keywords: [api]',
        '---',
        '# Nota API\n',
      ].join('\n'),
      // Rules file: at least 400 chars so readRuleExcerpts returns a full excerpt
      '/proj/CLAUDE.md': `# Big rules\n${'x'.repeat(500)}`,
    });

    const wsWithBigRules: Workspace = {
      ...workspace,
      root: '/proj',
      ruleSources: [{ repo: 'api', editor: 'Claude Code', path: 'CLAUDE.md' }],
    };

    // maxTokens=150 → maxChars=600; workspace+mapa+rules ≈ 770 chars → overflow
    const maxTokens = 150;
    const built = await new ContextBuilder(fs).build({
      workspace: wsWithBigRules,
      task: 'endpoint api',
      vaultPath: '/vault',
      maxTokens,
    });

    // Total must be within budget
    expect(built.context.length).toBeLessThanOrEqual(maxTokens * 4);

    // Map section must be present (not dropped by truncation)
    expect(built.context).toContain('## Mapa del vault');

    // Notice must be present
    expect(built.context).toContain('reglas recortadas');

    // reglasRecortadas flag must be set
    expect(built.mapa?.reglasRecortadas).toBe(true);
  });

  /**
   * Test 6 — fallback when vault has no chamba-generated root INDEX.md.
   * Written on UNCHANGED code so the snapshot captures the current behaviour;
   * any future regression breaks it.
   */
  it('fallback: vault without root INDEX.md uses current behaviour (snapshot)', async () => {
    const wsWithRules: Workspace = {
      ...workspace,
      root: '/proj',
      ruleSources: [{ repo: 'api', editor: 'Claude Code', path: 'CLAUDE.md' }],
    };
    const fs = new MemoryFilesystem({
      // Rules file
      '/proj/CLAUDE.md': '# API rules\nUse named exports.',
      // Vault — has only a legacy folder INDEX.md (no root INDEX.md)
      '/vault/.obsidian/app.json': '{}',
      '/vault/proyectos/INDEX.md': renderIndexNote('proyectos', [
        {
          title: 'Cursos API',
          path: 'cursos-api.md',
          description: 'api de cursos del lms para editar contenido',
        },
      ]),
      '/vault/proyectos/cursos-api.md': '# Cursos API\n\nendpoint para editar cursos en el LMS.\n',
      '/vault/notas/random.md': '# Random\n\nalgo sin relacion con la tarea.\n',
    });

    const built = await new ContextBuilder(fs).build({
      workspace: wsWithRules,
      task: 'endpoint para editar cursos',
      vaultPath: '/vault',
    });

    // Snapshot captures current (legacy) behaviour on unchanged code
    expect(built.context).toMatchSnapshot();

    // Structural assertions
    expect(built.context).toContain('## Relevant notes');
    expect(built.context).not.toContain('## Mapa del vault');

    // Coding rules section before Relevant notes (legacy order preserved)
    const rulesIdx = built.context.indexOf('## Coding rules');
    const notesIdx = built.context.indexOf('## Relevant notes');
    expect(rulesIdx).toBeGreaterThan(-1);
    expect(notesIdx).toBeGreaterThan(-1);
    expect(rulesIdx).toBeLessThan(notesIdx);
  });
});
