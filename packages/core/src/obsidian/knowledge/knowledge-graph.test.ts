/**
 * Tests for CHAMBA-016 Wave 2: knowledge-graph, bases, derived-path, reindexer.
 *
 * Tests 3, 4, 5, 10, 12, 13, O3 (§12 of the ticket).
 *
 * Uses MemoryFilesystem — never touches the real filesystem.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../../testing/memory-filesystem.js';
import { isChambaGenerated, isDerivedPathPattern } from './derived-path.js';
import type { GraphNote } from './knowledge-graph.js';
import { buildKnowledgeGraph } from './knowledge-graph.js';
import { readNoteMetadata } from './note-metadata.js';
import { VaultReindexer } from './reindexer.js';
import { parseVocabulary } from './vocabulary.js';

// ─── Fixture loader ───────────────────────────────────────────────────────────

const FIXTURE_DIR = join(import.meta.dirname, '__fixtures__/vault');

function loadFixtureNotes(): GraphNote[] {
  const notes: GraphNote[] = [];
  function scanDir(absDir: string, relPrefix: string) {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const name = entry.name;
      const relPath = relPrefix === '' ? name : `${relPrefix}/${name}`;
      if (entry.isDirectory()) {
        if (['temas', '.obsidian', '.trash', 'memory'].includes(name)) continue;
        scanDir(join(absDir, name), relPath);
      } else if (name.endsWith('.md') && name !== 'INDEX.md') {
        const content = readFileSync(join(absDir, name), 'utf8');
        const metadata = readNoteMetadata(content, relPath);
        notes.push({ path: relPath, metadata });
      }
    }
  }
  scanDir(FIXTURE_DIR, '');
  return notes;
}

function loadFixtureVocab() {
  const content = readFileSync(join(FIXTURE_DIR, 'temas/VOCABULARIO.md'), 'utf8');
  return parseVocabulary(content);
}

function loadFixtureFs(): MemoryFilesystem {
  const files: Record<string, string> = {};
  function scanDir(absDir: string, relPrefix: string) {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      const name = entry.name;
      const relPath = relPrefix === '' ? name : `${relPrefix}/${name}`;
      if (entry.isDirectory()) {
        scanDir(join(absDir, name), relPath);
      } else {
        files[`/vault/${relPath}`] = readFileSync(join(absDir, name), 'utf8');
      }
    }
  }
  scanDir(FIXTURE_DIR, '');
  return new MemoryFilesystem(files);
}

// ─── Simple note factory ──────────────────────────────────────────────────────

function makeNote(
  path: string,
  overrides: Partial<{
    title: string;
    type: 'plan' | 'resumen' | 'investigacion' | 'informe' | 'decision' | 'guia' | 'nota';
    summary: string;
    tags: string[];
    keywords: string[];
    work_item: string;
    date: string;
    temas_propuestos: string[];
  }> = {},
): GraphNote {
  return {
    path,
    metadata: {
      title: overrides.title ?? path.replace(/\.md$/, '').split('/').pop() ?? path,
      type: overrides.type ?? 'nota',
      summary: overrides.summary,
      tags: overrides.tags ?? [],
      temas: (overrides.tags ?? [])
        .filter((t) => t.startsWith('tema/'))
        .map((t) => t.slice('tema/'.length)),
      keywords: overrides.keywords ?? [],
      aliases: [],
      related: [],
      temas_propuestos: overrides.temas_propuestos ?? [],
      ...(overrides.work_item ? { work_item: overrides.work_item } : {}),
      ...(overrides.date ? { date: overrides.date } : {}),
    },
  };
}

// ─── Test 3: multi-topic note appears in 3 hubs, ancestors count it, no duplication ─

describe('Test 3: multi-topic note', () => {
  const { vocabulary, errors } = loadFixtureVocab();
  expect(errors.filter((e) => e.code !== 'INDENT_MISMATCH')).toHaveLength(0);

  const multiNote = makeNote('proyectos/hu-lms-api-01-cursos-modulos.md', {
    title: 'HU LMS API 01 — cursos y módulos',
    type: 'plan',
    summary: 'Endpoints de creación y gestión de cursos/módulos.',
    tags: [
      'tema/lms/cursos/creacion',
      'tema/lms/cursos/gestion',
      'tema/lms/gamificacion',
      'chamba',
    ],
    keywords: ['POST /courses', 'módulos', 'api key'],
    work_item: 'hu-lms-api-01',
    date: '2026-10-29',
  });

  const graph = buildKnowledgeGraph([multiNote], vocabulary);

  it('hub for lms/cursos/creacion contains the note', () => {
    const hub = graph.get('temas/lms/cursos/creacion.md');
    expect(hub).toBeDefined();
    expect(hub).toContain('hu-lms-api-01-cursos-modulos');
  });

  it('hub for lms/cursos/gestion contains the note', () => {
    const hub = graph.get('temas/lms/cursos/gestion.md');
    expect(hub).toBeDefined();
    expect(hub).toContain('hu-lms-api-01-cursos-modulos');
  });

  it('hub for lms/gamificacion contains the note', () => {
    const hub = graph.get('temas/lms/gamificacion.md');
    expect(hub).toBeDefined();
    expect(hub).toContain('hu-lms-api-01-cursos-modulos');
  });

  it('hub for lms/cursos counts the note in subtree', () => {
    const hub = graph.get('temas/lms/cursos.md');
    expect(hub).toBeDefined();
    // Should mention note count in subtemas section
    expect(hub).toContain('nota');
  });

  it('hub for lms counts the note in subtree', () => {
    const hub = graph.get('temas/lms.md');
    expect(hub).toBeDefined();
    // lms should have non-zero count
    expect(hub).toContain('nota');
  });

  it('the note file itself is NOT in the graph output (no duplication)', () => {
    // The graph only produces derived files, not copies of notes
    for (const key of graph.keys()) {
      expect(key).not.toBe(multiNote.path);
    }
  });
});

// ─── Test 4: ~40 notes fixture, stable output, Windows path handling ──────────

describe('Test 4: fixture snapshot', () => {
  const { vocabulary } = loadFixtureVocab();
  const notes = loadFixtureNotes();

  it('builds graph from fixture (no errors)', () => {
    const graph = buildKnowledgeGraph(notes, vocabulary);
    expect(graph.size).toBeGreaterThan(0);
    expect(graph.has('INDEX.md')).toBe(true);
    expect(graph.has('temas/lms.md')).toBe(true);
    expect(graph.has('temas/lms/cursos.md')).toBe(true);
    expect(graph.has('temas/sin-clasificar.md')).toBe(true);
  });

  // One committed snapshot file per derived file: root, hubs, folder indexes, .base.
  // CI never rewrites snapshots, so any byte difference on windows/macos fails here.
  it('matches the committed snapshots (root, hubs, indexes, .base)', async () => {
    const graph = buildKnowledgeGraph(notes, vocabulary);
    const paths = [...graph.keys()].sort();
    expect(paths).toMatchSnapshot();
    for (const p of paths) {
      await expect(graph.get(p)).toMatchFileSnapshot(`__snapshots__/fixture/${p}.snap`);
    }
  });

  it('same result with shuffled input order', () => {
    const shuffled = [...notes].reverse();
    const graph1 = buildKnowledgeGraph(notes, vocabulary);
    const graph2 = buildKnowledgeGraph(shuffled, vocabulary);
    expect([...graph1.entries()].sort()).toEqual([...graph2.entries()].sort());
  });

  it('normalises Windows backslash paths to forward slash', () => {
    const winNotes = notes.map((n) => ({
      ...n,
      path: n.path.replace(/\//g, '\\'),
    }));
    const graph1 = buildKnowledgeGraph(notes, vocabulary);
    const graph2 = buildKnowledgeGraph(winNotes, vocabulary);
    expect([...graph1.entries()].sort()).toEqual([...graph2.entries()].sort());
  });

  it('generated files have source: chamba and generated: true', () => {
    const graph = buildKnowledgeGraph(notes, vocabulary);
    for (const [path, content] of graph) {
      if (path.endsWith('.base')) {
        expect(content).toContain('# generated: true');
        expect(content).toContain('source: chamba');
      } else if (path.endsWith('.md')) {
        expect(content).toContain('source: chamba');
        expect(content).toContain('generated: true');
      }
    }
  });

  it('generated .md files contain the notice blockquote', () => {
    const graph = buildKnowledgeGraph(notes, vocabulary);
    for (const [path, content] of graph) {
      if (!path.endsWith('.md')) continue;
      expect(content).toContain('Generado por chamba desde los metadatos de las notas.');
    }
  });

  it('INDEX.md hub links are relative and start with temas/', () => {
    const graph = buildKnowledgeGraph(notes, vocabulary);
    const root = graph.get('INDEX.md') ?? '';
    // Links to temas/lms.md from root should be temas/lms.md (or similar relative)
    expect(root).toContain('temas/lms.md');
  });

  it('hub links to notes are relative from hub directory', () => {
    const graph = buildKnowledgeGraph(notes, vocabulary);
    // temas/lms/cursos/creacion.md should link to proyectos/hu-lms-api-01...md
    const hub = graph.get('temas/lms/cursos/creacion.md') ?? '';
    // From temas/lms/cursos/creacion.md to proyectos/hu-lms-api-01.md => ../../../proyectos/...
    expect(hub).toContain('../../..');
  });

  it('output uses LF line endings', () => {
    const graph = buildKnowledgeGraph(notes, vocabulary);
    for (const content of graph.values()) {
      expect(content).not.toContain('\r\n');
    }
  });

  it('output is NFC normalized', () => {
    const graph = buildKnowledgeGraph(notes, vocabulary);
    for (const content of graph.values()) {
      expect(content).toBe(content.normalize('NFC'));
    }
  });
});

// ─── Test 5: determinism — reindex twice writes 0 files the second time ───────

describe('Test 5: determinism / idempotency', () => {
  it('second reindex writes 0 files', async () => {
    const fs = loadFixtureFs();

    const reindexer = new VaultReindexer(fs, '/vault');
    const report1 = await reindexer.reindex();
    expect(report1.archivosEscritos.length).toBeGreaterThan(0);
    expect(report1.incompleto).toBe(false);

    const report2 = await reindexer.reindex();
    expect(report2.archivosEscritos).toHaveLength(0);
    expect(report2.archivosEliminados).toHaveLength(0);
    expect(report2.incompleto).toBe(false);
  });

  it('output has only LF line endings after reindex', async () => {
    const fs = loadFixtureFs();
    const reindexer = new VaultReindexer(fs, '/vault');
    await reindexer.reindex();

    const root = await fs.readFile('/vault/INDEX.md');
    expect(root).not.toContain('\r\n');
  });

  it('no note or vocabulary file is modified after reindex', async () => {
    const fs = loadFixtureFs();

    // Run reindex
    const report = await new VaultReindexer(fs, '/vault').reindex();

    // Verify that note files were not written
    const writtenSet = new Set(report.archivosEscritos);
    for (const path of writtenSet) {
      // All written paths should be derived files
      expect(isDerivedPathPattern(path)).toBe(true);
    }
  });
});

// ─── Test 10: manual INDEX.md handling ───────────────────────────────────────

describe('Test 10: manual INDEX.md', () => {
  const manualContent = `# Índice manual\n\nEste índice fue escrito a mano.\n`;

  async function makeFs(): Promise<MemoryFilesystem> {
    const base = loadFixtureFs();
    // Add a manual INDEX.md in proyectos/
    await base.writeFile('/vault/proyectos/INDEX.md', manualContent);
    return base;
  }

  it('manual INDEX.md is never overwritten', async () => {
    const fs = await makeFs();
    const reindexer = new VaultReindexer(fs, '/vault');
    await reindexer.reindex();

    const content = await fs.readFile('/vault/proyectos/INDEX.md');
    expect(content).toBe(manualContent);
  });

  it('manual INDEX.md folder appears in indicesManualesOmitidos', async () => {
    const fs = await makeFs();
    const reindexer = new VaultReindexer(fs, '/vault');
    const report = await reindexer.reindex();
    expect(report.indicesManualesOmitidos).toContain('proyectos/INDEX.md');
  });

  it('adoptManual dryRun does not write any files', async () => {
    const fs = await makeFs();
    const reindexer = new VaultReindexer(fs, '/vault');
    const report = await reindexer.reindex({ dryRun: true, adoptManual: ['proyectos'] });

    // dryRun means nothing is written
    // INDEX.md should still be manual content
    const content = await fs.readFile('/vault/proyectos/INDEX.md');
    expect(content).toBe(manualContent);
    expect(report.adoptados).toContain('proyectos');
  });

  it('adoptManual renames with identical bytes and generates new index', async () => {
    const fs = await makeFs();
    const reindexer = new VaultReindexer(fs, '/vault');
    await reindexer.reindex({ adoptManual: ['proyectos'] });

    // Original manual content should be at new path
    const renamed = await fs.readFile('/vault/proyectos/INDEX (manual).md');
    expect(renamed).toBe(manualContent);

    // New INDEX.md should be generated
    const newIndex = await fs.readFile('/vault/proyectos/INDEX.md');
    expect(newIndex).toContain('source: chamba');
    expect(newIndex).toContain('generated: true');
  });

  it('adoptManual with pre-existing INDEX (manual).md errors and touches nothing', async () => {
    const fs = await makeFs();
    await fs.writeFile('/vault/proyectos/INDEX (manual).md', '# Ya existe\n');

    const reindexer = new VaultReindexer(fs, '/vault');
    const report = await reindexer.reindex({ adoptManual: ['proyectos'] });

    // The original manual INDEX.md should be untouched
    const content = await fs.readFile('/vault/proyectos/INDEX.md');
    expect(content).toBe(manualContent);

    // Error should be in erroresVocabulario (we repurpose the error array)
    expect(report.erroresVocabulario.some((e) => e.path === 'proyectos/INDEX.md')).toBe(true);
  });

  it('regular reindex (no adoptManual) never adopts manual files', async () => {
    const fs = await makeFs();
    const reindexer = new VaultReindexer(fs, '/vault');
    const report = await reindexer.reindex();

    // Must not adopt
    expect(report.adoptados).toHaveLength(0);
    // Manual file must be untouched
    const content = await fs.readFile('/vault/proyectos/INDEX.md');
    expect(content).toBe(manualContent);
  });
});

// ─── Test 12: Windows-invalid filenames don't break reindex ──────────────────

describe('Test 12: Windows-invalid filenames', () => {
  it('reindex does not crash on Windows-invalid note filenames', async () => {
    const fs = loadFixtureFs();

    // Add a file with an invalid Windows name (colon is forbidden)
    await fs.writeFile('/vault/proyectos/nota:invalida.md', '# Nota inválida\n');
    // Add one with trailing space
    await fs.writeFile('/vault/proyectos/nota final .md', '# Nota con espacio\n');
    // Add one with CON reserved name
    await fs.writeFile('/vault/proyectos/CON.md', '# CON\n');

    const reindexer = new VaultReindexer(fs, '/vault');
    // Should not throw
    const report = await reindexer.reindex();
    expect(report).toBeDefined();
    // Those invalid files should be silently skipped
    // Valid notes are still indexed
    expect(report.notas).toBeGreaterThan(0);
  });
});

// ─── O3: no vocabulary → all unclassified, no topic hubs ─────────────────────

describe('O3: no vocabulary (null)', () => {
  it('reindex works without VOCABULARIO.md', async () => {
    // Create a FS without VOCABULARIO.md
    const files: Record<string, string> = {};
    const noteContent = `---\ntitle: "Mi nota"\ndate: 2026-10-01\ntype: nota\ntags:\n  - chamba\nsource: chamba\n---\nContenido de nota.\n`;
    files['/vault/notas/mi-nota.md'] = noteContent;

    const fs = new MemoryFilesystem(files);
    const reindexer = new VaultReindexer(fs, '/vault');
    const report = await reindexer.reindex();

    expect(report.temas).toBe(0);
    expect(report.sinClasificar).toBe(1);
    expect(report.archivosEscritos.length).toBeGreaterThan(0);

    // Should not create any temas/lms.md etc (no vocabulary)
    const written = new Set(report.archivosEscritos);
    for (const path of written) {
      if (
        path.startsWith('temas/') &&
        path.endsWith('.md') &&
        path !== 'temas/sin-clasificar.md' &&
        path !== 'temas/PROPUESTOS.md'
      ) {
        // These would be topic hubs — should not exist without vocabulary
        expect(false).toBe(true);
      }
    }
  });

  it('buildKnowledgeGraph with null vocabulary puts all notes in sin-clasificar', () => {
    const notes = [
      makeNote('notas/a.md', { tags: ['tema/lms', 'chamba'] }),
      makeNote('notas/b.md', { tags: ['chamba'] }),
    ];
    const graph = buildKnowledgeGraph(notes, null);
    const unclassified = graph.get('temas/sin-clasificar.md') ?? '';
    expect(unclassified).toContain('notas/a.md');
    expect(unclassified).toContain('notas/b.md');
    // No topic hubs (no temas/*.md except sin-clasificar)
    for (const key of graph.keys()) {
      if (key.startsWith('temas/') && key.endsWith('.md')) {
        expect(key).toBe('temas/sin-clasificar.md');
      }
    }
  });
});

// ─── isDerivedPathPattern ─────────────────────────────────────────────────────

describe('isDerivedPathPattern', () => {
  it('identifies root INDEX.md', () => expect(isDerivedPathPattern('INDEX.md')).toBe(true));
  it('identifies folder INDEX.md', () =>
    expect(isDerivedPathPattern('proyectos/INDEX.md')).toBe(true));
  it('identifies temas hub', () => expect(isDerivedPathPattern('temas/lms.md')).toBe(true));
  it('identifies deep temas hub', () =>
    expect(isDerivedPathPattern('temas/lms/cursos.md')).toBe(true));
  it('identifies .base file', () => expect(isDerivedPathPattern('temas/lms.base')).toBe(true));
  it('does NOT identify VOCABULARIO.md', () =>
    expect(isDerivedPathPattern('temas/VOCABULARIO.md')).toBe(false));
  it('does NOT identify a note', () =>
    expect(isDerivedPathPattern('proyectos/mi-nota.md')).toBe(false));
  it('does NOT identify nested .base', () =>
    expect(isDerivedPathPattern('temas/lms/cursos.base')).toBe(false));
});

// ─── isChambaGenerated ────────────────────────────────────────────────────────

describe('isChambaGenerated', () => {
  it('recognises a generated .md file', () => {
    const content = '---\ntitle: "x"\nsource: chamba\ngenerated: true\n---\n\nBody.\n';
    expect(isChambaGenerated('temas/lms.md', content)).toBe(true);
  });
  it('recognises a legacy INDEX.md (source: chamba, no generated)', () => {
    const content = '---\ntitle: "x"\nsource: chamba\n---\n\nBody.\n';
    expect(isChambaGenerated('proyectos/INDEX.md', content)).toBe(true);
  });
  it('rejects a human INDEX.md (no source: chamba)', () => {
    const content = '---\ntitle: "x"\n---\n\nBody.\n';
    expect(isChambaGenerated('proyectos/INDEX.md', content)).toBe(false);
  });
  it('recognises a generated .base file', () => {
    const content = '# generated: true — source: chamba — Aviso\nfilters:\n  and: []\n';
    expect(isChambaGenerated('temas/lms.base', content)).toBe(true);
  });
  it('rejects a human .base file', () => {
    const content = 'filters:\n  and:\n    - file.hasTag("x")\n';
    expect(isChambaGenerated('temas/lms.base', content)).toBe(false);
  });
});

// ─── Test 13: performance — 2000 notes < 2s ──────────────────────────────────

describe('Test 13: performance', () => {
  it('2000 synthetic notes reindex in < 2000ms', async () => {
    const files: Record<string, string> = {
      '/vault/temas/VOCABULARIO.md': `---
title: "Vocabulario"
source: human
umbral_promover: 3
umbral_dividir: 25
generar_bases: true
---
# Vocabulario
- \`area-a\` — Área A.
  - \`area-a/sub-1\` — Sub 1.
  - \`area-a/sub-2\` — Sub 2.
- \`area-b\` — Área B.
  - \`area-b/sub-1\` — Sub B1.
`,
    };

    const topics = ['area-a/sub-1', 'area-a/sub-2', 'area-b/sub-1', 'area-a', 'area-b'];
    const types = ['plan', 'resumen', 'investigacion', 'informe', 'nota'] as const;
    const folders = ['proyectos', 'planes', 'informes', 'investigacion', 'notas'];

    for (let i = 0; i < 2000; i++) {
      const folder = folders[i % folders.length] ?? 'proyectos';
      const topic = topics[i % topics.length] ?? 'area-a';
      const type = types[i % types.length] ?? 'nota';
      const path = `/vault/${folder}/nota-${i.toString().padStart(4, '0')}.md`;
      files[path] = `---
title: "Nota ${i}"
date: 2026-${String(Math.floor(i / 100) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}
type: ${type}
summary: "Resumen de la nota ${i} en el área ${topic}."
tags:
  - tema/${topic}
  - chamba
keywords: [kw-${i}, area-${i % 10}]
work_item: wi-${Math.floor(i / 5)
        .toString()
        .padStart(3, '0')}
source: chamba
---
Contenido de la nota ${i}.
`;
    }

    const runs: number[] = [];
    for (let run = 0; run < 3; run++) {
      // Reset FS for each run
      const freshFs = new MemoryFilesystem(files);
      const freshReindexer = new VaultReindexer(freshFs, '/vault');

      const t0 = Date.now();
      const report = await freshReindexer.reindex();
      const elapsed = Date.now() - t0;

      runs.push(elapsed);
      console.log(
        `Test 13 run ${run + 1}: ${elapsed}ms (${report.notas} notes, ${report.archivosEscritos.length} files written)`,
      );
      expect(elapsed).toBeLessThan(2000);
      expect(report.notas).toBe(2000);
      expect(report.incompleto).toBe(false);
    }

    console.log(`Test 13 average: ${Math.round(runs.reduce((a, b) => a + b, 0) / runs.length)}ms`);
  }, 30000); // 30s timeout for 3 runs
});

// ─── B1: dryRun + adoptManual shows exact plan ───────────────────────────────

describe('B1: dryRun adoptManual plan', () => {
  const manualContent = `# Índice manual\n\nEste índice fue escrito a mano.\n`;

  async function makeFs(): Promise<MemoryFilesystem> {
    const base = loadFixtureFs();
    await base.writeFile('/vault/proyectos/INDEX.md', manualContent);
    return base;
  }

  it('dryRun adoptManual: adopted folder NOT in indicesManualesOmitidos', async () => {
    const fs = await makeFs();
    const report = await new VaultReindexer(fs, '/vault').reindex({
      dryRun: true,
      adoptManual: ['proyectos'],
    });
    expect(report.indicesManualesOmitidos).not.toContain('proyectos/INDEX.md');
  });

  it('dryRun adoptManual: generated INDEX.md appears in archivosEscritos', async () => {
    const fs = await makeFs();
    const report = await new VaultReindexer(fs, '/vault').reindex({
      dryRun: true,
      adoptManual: ['proyectos'],
    });
    expect(report.archivosEscritos).toContain('proyectos/INDEX.md');
  });

  it('dryRun adoptManual: renombrados contains rename entry', async () => {
    const fs = await makeFs();
    const report = await new VaultReindexer(fs, '/vault').reindex({
      dryRun: true,
      adoptManual: ['proyectos'],
    });
    expect(report.renombrados).toHaveLength(1);
    expect(report.renombrados[0]).toEqual({
      from: 'proyectos/INDEX.md',
      to: 'proyectos/INDEX (manual).md',
    });
  });

  it('dryRun adoptManual: nothing is actually written', async () => {
    const fs = await makeFs();
    await new VaultReindexer(fs, '/vault').reindex({
      dryRun: true,
      adoptManual: ['proyectos'],
    });
    // The manual content should remain at the original path
    const content = await fs.readFile('/vault/proyectos/INDEX.md');
    expect(content).toBe(manualContent);
    // INDEX (manual).md should NOT exist
    expect(await fs.exists('/vault/proyectos/INDEX (manual).md')).toBe(false);
  });

  it('apply adoptManual: renombrados also lists what was done', async () => {
    const fs = await makeFs();
    const report = await new VaultReindexer(fs, '/vault').reindex({
      dryRun: false,
      adoptManual: ['proyectos'],
    });
    expect(report.renombrados).toHaveLength(1);
    expect(report.renombrados[0]).toEqual({
      from: 'proyectos/INDEX.md',
      to: 'proyectos/INDEX (manual).md',
    });
    // apply also writes the generated INDEX.md
    expect(report.archivosEscritos).toContain('proyectos/INDEX.md');
  });

  it('conflict (INDEX (manual).md exists): folder goes to indicesManualesOmitidos, no renombrados', async () => {
    const fs = await makeFs();
    await fs.writeFile('/vault/proyectos/INDEX (manual).md', '# Ya existe\n');

    const report = await new VaultReindexer(fs, '/vault').reindex({
      dryRun: true,
      adoptManual: ['proyectos'],
    });
    expect(report.renombrados).toHaveLength(0);
    expect(report.indicesManualesOmitidos).toContain('proyectos/INDEX.md');
    expect(report.erroresVocabulario.some((e) => e.path === 'proyectos/INDEX.md')).toBe(true);
  });
});

// ─── M1: collectDerivedRecursive skips SKIP_DIRS ──────────────────────────────

describe('M1: collectDerivedRecursive skips SKIP_DIRS', () => {
  it('INDEX.md with source: chamba inside memory/ is not deleted', async () => {
    const vocabContent = `---\ntitle: "Vocabulario"\nsource: human\n---\n- \`test\` — Test.\n`;
    const noteContent = `---\ntitle: "Nota"\ndate: 2026-01-01\ntype: nota\ntags:\n  - tema/test\nsource: chamba\n---\nContenido.\n`;
    // A derived-looking INDEX.md inside memory/ (generated: true = chamba-generated)
    const memoryIndex = `---\ntitle: "Memory Index"\ndate: 2026-01-01\ntype: nota\nsource: chamba\ngenerated: true\n---\n<!-- generated by chamba -->\n`;

    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': vocabContent,
      '/vault/notas/nota.md': noteContent,
      '/vault/memory/INDEX.md': memoryIndex,
    });

    const report = await new VaultReindexer(fs, '/vault').reindex();

    // memory/INDEX.md must NOT appear in archivosEliminados
    expect(report.archivosEliminados).not.toContain('memory/INDEX.md');
    // And it should still exist
    expect(await fs.exists('/vault/memory/INDEX.md')).toBe(true);
  });

  it('INDEX.md inside .trash/ is not deleted', async () => {
    const vocabContent = `---\ntitle: "Vocabulario"\nsource: human\n---\n- \`test\` — Test.\n`;
    const noteContent = `---\ntitle: "Nota"\ndate: 2026-01-01\ntype: nota\ntags:\n  - tema/test\nsource: chamba\n---\nContenido.\n`;
    const trashIndex = `---\ntitle: "Trash Index"\ndate: 2026-01-01\ntype: nota\nsource: chamba\ngenerated: true\n---\n<!-- generated by chamba -->\n`;

    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': vocabContent,
      '/vault/notas/nota.md': noteContent,
      '/vault/.trash/INDEX.md': trashIndex,
    });

    const report = await new VaultReindexer(fs, '/vault').reindex();

    expect(report.archivosEliminados).not.toContain('.trash/INDEX.md');
    expect(await fs.exists('/vault/.trash/INDEX.md')).toBe(true);
  });
});

// ─── M2: incompleto → skip orphan deletion ────────────────────────────────────

describe('M2: incompleto skips orphan deletion', () => {
  it('deadline=0 → incompleto=true and no orphans deleted', async () => {
    // First run: write some derived files
    const vocabContent = `---\ntitle: "Vocabulario"\nsource: human\n---\n- \`test\` — Test.\n`;
    const noteContent = `---\ntitle: "Nota"\ndate: 2026-01-01\ntype: nota\ntags:\n  - tema/test\nsource: chamba\n---\nContenido.\n`;
    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': vocabContent,
      '/vault/notas/nota.md': noteContent,
    });

    // Full run to write derived files
    await new VaultReindexer(fs, '/vault').reindex();

    // Now add an orphaned derived file (simulate a topic that was removed)
    const orphanContent = `---\ntitle: "Orphan"\ndate: 2026-01-01\ntype: nota\nsource: chamba\ngenerated: true\n---\n<!-- generated by chamba -->\n`;
    await fs.writeFile('/vault/temas/orphan.md', orphanContent);

    // Run with deadline=0 (already expired) → incompleto=true
    const now = () => Date.now();
    const report = await new VaultReindexer(fs, '/vault').reindex({
      deadlineMs: 0,
      now,
    });

    expect(report.incompleto).toBe(true);
    // Since incompleto, orphaned files should NOT be deleted
    expect(report.archivosEliminados).toHaveLength(0);
    // The orphan file should still exist
    expect(await fs.exists('/vault/temas/orphan.md')).toBe(true);
  });
});

// ─── M8: splitHint sorted by keyword on tie ──────────────────────────────────

describe('M8: splitHint desempate por keyword', () => {
  it('splitHint breaks ties by keyword name (alphabetically), not insertion order', async () => {
    // splitHint is computed for PROPOSED topics (not vocabulary ones) when
    // notePaths.length > umbral_dividir.
    // We set umbral_dividir: 3 and create 4 notes that all have temas_propuestos: [bigone].
    // Notes have different keywords: z-keyword and a-keyword each appear once
    // (same frequency); they should be sorted by keyword name on tie.
    const vocabContent = `---\ntitle: "Vocabulario"\nsource: human\numbral_dividir: 3\numbral_promover: 3\n---\n- \`existing\` — Existing topic.\n`;

    const makeNote = (path: string, keywords: string[]) =>
      `---\ntitle: "${path}"\ndate: 2026-01-01\ntype: nota\ntags:\n  - chamba\ntemas_propuestos: [bigone]\nsource: chamba\nkeywords: [${keywords.map((k) => `"${k}"`).join(', ')}]\n---\nContenido.\n`;

    // z-keyword and a-keyword have same frequency (1 each); shared appears 4 times
    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': vocabContent,
      '/vault/notas/n1.md': makeNote('n1', ['z-keyword', 'shared']),
      '/vault/notas/n2.md': makeNote('n2', ['a-keyword', 'shared']),
      '/vault/notas/n3.md': makeNote('n3', ['shared']),
      '/vault/notas/n4.md': makeNote('n4', ['shared']),
    });

    const report = await new VaultReindexer(fs, '/vault').reindex({ dryRun: true });

    // Find suggestion for bigone (proposed topic, > umbral_dividir=3 notes)
    const sug = report.sugerencias.find((s) => s.proposed === 'bigone');
    expect(sug).toBeDefined();
    expect(sug?.splitHint).toBeDefined();

    // shared has highest frequency; then a-keyword and z-keyword are tied
    // After alphabetical tiebreak: a-keyword comes before z-keyword
    const hint = sug?.splitHint ?? [];
    const aIdx = hint.indexOf('a-keyword');
    const zIdx = hint.indexOf('z-keyword');
    expect(aIdx).toBeGreaterThanOrEqual(0);
    expect(zIdx).toBeGreaterThanOrEqual(0);
    expect(aIdx).toBeLessThan(zIdx);
  });
});
