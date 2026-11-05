/**
 * Tests 3–5 — context-map (CHAMBA-017).
 *
 * Test 3: Relevance scoring + multi-topic note deduplication + mapa ≤ 25% of budget.
 * Test 4: work_item notes always included when task mentions them.
 * Test 5: Efficiency — 200-note generated vault, ≤ 8 body reads, 3 expected notes survive.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../../testing/memory-filesystem.js';
import { buildContextMap } from './context-map.js';
import type { GraphNote } from './knowledge-graph.js';
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

// ─── Test 3: Relevance + deduplication + budget ───────────────────────────────

describe('buildContextMap — test 3: relevance and budget', () => {
  /**
   * Task from §4 of the plan.
   * Expected top-3: {lms/cursos/creacion, lms/cursos/gestion, lms/gamificacion}
   * (verified in §4: "Paso 1" of the scoring algorithm).
   */
  const TASK = 'endpoint para editar cursos y otorgar insignias en LMS API';
  const MAX_TOKENS = 2000;

  it('top-3 nodes include lms/cursos/gestion and lms/gamificacion', () => {
    const notes = loadFixtureNotes();
    const { vocabulary } = loadFixtureVocab();
    const { mapa } = buildContextMap(notes, vocabulary ?? null, TASK, { maxTokens: MAX_TOKENS });

    const nodeRutas = mapa.nodos.map((n) => n.ruta);
    expect(nodeRutas).toContain('lms/cursos/gestion');
    expect(nodeRutas).toContain('lms/gamificacion');
    // Top 3 max
    expect(mapa.nodos.length).toBeLessThanOrEqual(3);
  });

  it('note hu-lms-api-01 (multi-topic) appears only once across all nodes', () => {
    const notes = loadFixtureNotes();
    const { vocabulary } = loadFixtureVocab();
    const { mapa } = buildContextMap(notes, vocabulary ?? null, TASK, { maxTokens: MAX_TOKENS });

    // Collect all note paths across nodes
    const allNotePaths = mapa.nodos.flatMap((n) => n.notas.map((note) => note.ruta));

    // hu-lms-api-01-cursos-modulos has lms/cursos/creacion, lms/cursos/gestion AND lms/gamificacion tags
    const multiTopicNote = 'proyectos/hu-lms-api-01-cursos-modulos.md';
    const occurrences = allNotePaths.filter((p) => p === multiTopicNote).length;
    expect(occurrences).toBeLessThanOrEqual(1); // appears at most once (deduplication)
  });

  it('mapa section length ≤ 25% of maxTokens*4 chars (mapBudgetChars)', () => {
    const notes = loadFixtureNotes();
    const { vocabulary } = loadFixtureVocab();
    const { section } = buildContextMap(notes, vocabulary ?? null, TASK, { maxTokens: MAX_TOKENS });

    const mapBudgetChars = Math.floor(MAX_TOKENS * 4 * 0.25); // = MAX_TOKENS = 2000
    expect(section.length).toBeLessThanOrEqual(mapBudgetChars);
  });

  it('section contains ## Mapa del vault header', () => {
    const notes = loadFixtureNotes();
    const { vocabulary } = loadFixtureVocab();
    const { section } = buildContextMap(notes, vocabulary ?? null, TASK, { maxTokens: MAX_TOKENS });

    expect(section).toContain('## Mapa del vault');
  });

  it('section contains the closing navigation hint', () => {
    const notes = loadFixtureNotes();
    const { vocabulary } = loadFixtureVocab();
    const { section } = buildContextMap(notes, vocabulary ?? null, TASK, { maxTokens: MAX_TOKENS });

    expect(section).toContain('chamba_vault_navigate');
  });
});

// ─── Test 4: work_item notes always included ──────────────────────────────────

describe('buildContextMap — test 4: work_item inclusion', () => {
  it('includes all notes with hu-lms-api-01 when task mentions that ID', async () => {
    // Create an in-memory vault with a plan and resumen sharing work_item hu-lms-api-01
    const vocabContent = [
      '---',
      'title: "Vocabulary"',
      'source: human',
      'umbral_promover: 3',
      'umbral_dividir: 25',
      'generar_bases: false',
      '---',
      '# Vocab',
      '',
      '- `lms` — LMS system.',
      '  - `lms/api` — API endpoints.',
    ].join('\n');

    const planContent = [
      '---',
      'title: "Plan LMS API 01"',
      'date: 2026-10-01',
      'type: plan',
      'summary: "Plan for LMS API endpoints - low keyword match"',
      'tags:',
      '  - tema/lms/api',
      '  - chamba',
      'keywords: [lms, api]',
      'work_item: hu-lms-api-01',
      'related: []',
      'temas_propuestos: []',
      'source: chamba',
      '---',
      '# Plan LMS API 01',
    ].join('\n');

    const resumenContent = [
      '---',
      'title: "Resumen LMS API 01"',
      'date: 2026-10-15',
      'type: resumen',
      'summary: "Summary of LMS API - low keyword match"',
      'tags:',
      '  - tema/lms/api',
      '  - chamba',
      'keywords: [lms, api, resumen]',
      'work_item: hu-lms-api-01',
      'related: []',
      'temas_propuestos: []',
      'source: chamba',
      '---',
      '# Resumen LMS API 01',
    ].join('\n');

    const unrelatedContent = [
      '---',
      'title: "Infra Note"',
      'date: 2026-10-01',
      'type: nota',
      'summary: "Infrastructure unrelated to task"',
      'tags:',
      '  - tema/lms/api',
      '  - chamba',
      'keywords: [infra]',
      'related: []',
      'temas_propuestos: []',
      'source: chamba',
      '---',
      '# Infra',
    ].join('\n');

    const notes: GraphNote[] = [
      {
        path: 'planes/plan-lms-01.md',
        metadata: readNoteMetadata(planContent, 'planes/plan-lms-01.md'),
      },
      {
        path: 'planes/resumen-lms-01.md',
        metadata: readNoteMetadata(resumenContent, 'planes/resumen-lms-01.md'),
      },
      { path: 'infra/note.md', metadata: readNoteMetadata(unrelatedContent, 'infra/note.md') },
    ];

    const { vocabulary } = parseVocabulary(vocabContent);

    // Task that mentions hu-lms-api-01 explicitly
    const task = 'implement endpoints for hu-lms-api-01 user story';
    const { mapa } = buildContextMap(notes, vocabulary ?? null, task, { maxTokens: 2000 });

    // Both plan and resumen should appear in work items (even if they score low on keywords)
    expect(mapa.workItems).toHaveLength(1);
    expect(mapa.workItems[0]?.id).toBe('hu-lms-api-01');

    const wiNotePaths = mapa.workItems[0]?.notas.map((n) => n.ruta);
    expect(wiNotePaths).toContain('planes/plan-lms-01.md');
    expect(wiNotePaths).toContain('planes/resumen-lms-01.md');
  });
});

// ─── Test 5: Efficiency — 200-note vault ──────────────────────────────────────

describe('buildContextMap — test 5: 200-note vault efficiency', () => {
  it('map contains ≤ 3 nodes × 5 notes and identifies the 3 planted notes', async () => {
    // Build a 200-note MemoryFilesystem deterministically
    const TASK_TERMS = 'endpoint para editar cursos y otorgar insignias en LMS API';

    // 3 "expected" notes: planted with terms that should score high
    const EXPECTED_PATHS = [
      'proyectos/nota-cursos-gestion-01.md',
      'proyectos/nota-gamificacion-insignias-01.md',
      'proyectos/nota-cursos-edicion-01.md',
    ] as const;

    const vocabContent = [
      '---',
      'title: "Vocabulary"',
      'source: human',
      'umbral_promover: 3',
      'umbral_dividir: 25',
      'generar_bases: false',
      '---',
      '# Vocab',
      '',
      '- `lms` — LMS system. Alias: plataforma',
      '  - `lms/cursos` — Cursos.',
      '    - `lms/cursos/gestion` — Edicion y publicacion. Alias: gestion-cursos',
      '  - `lms/gamificacion` — Insignias y puntos. Alias: gamification',
    ].join('\n');

    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': vocabContent,
    });

    // Plant the 3 expected notes with highly relevant keywords
    await fs.writeFile(
      '/vault/proyectos/nota-cursos-gestion-01.md',
      [
        '---',
        'title: "Gestión de cursos"',
        'date: 2026-10-01',
        'type: plan',
        'summary: "Endpoints para editar cursos en el LMS API"',
        'tags:',
        '  - tema/lms/cursos/gestion',
        '  - chamba',
        'keywords: [editar, cursos, endpoint, lms, api]',
        'related: []',
        'temas_propuestos: []',
        'source: chamba',
        '---',
        '# Gestión de cursos',
      ].join('\n'),
    );

    await fs.writeFile(
      '/vault/proyectos/nota-gamificacion-insignias-01.md',
      [
        '---',
        'title: "Sistema de insignias"',
        'date: 2026-10-02',
        'type: investigacion',
        'summary: "Otorgar insignias en LMS API gamificacion"',
        'tags:',
        '  - tema/lms/gamificacion',
        '  - chamba',
        'keywords: [insignias, otorgar, gamificacion, lms, api]',
        'related: []',
        'temas_propuestos: []',
        'source: chamba',
        '---',
        '# Sistema de insignias',
      ].join('\n'),
    );

    await fs.writeFile(
      '/vault/proyectos/nota-cursos-edicion-01.md',
      [
        '---',
        'title: "Edición de cursos API"',
        'date: 2026-10-03',
        'type: guia',
        'summary: "Guia para editar cursos via endpoint LMS"',
        'tags:',
        '  - tema/lms/cursos/gestion',
        '  - chamba',
        'keywords: [editar, cursos, endpoint, api]',
        'related: []',
        'temas_propuestos: []',
        'source: chamba',
        '---',
        '# Edición de cursos API',
      ].join('\n'),
    );

    // Add 197 noise notes with varied topics
    const noiseTopics = ['lms/cursos/gestion', 'lms/gamificacion'] as const;
    for (let i = 0; i < 197; i++) {
      const topic = noiseTopics[i % noiseTopics.length];
      const path = `/vault/notas/noise-${String(i).padStart(3, '0')}.md`;
      await fs.writeFile(
        path,
        [
          '---',
          `title: "Nota de ruido ${i}"`,
          `date: 2026-0${1 + (i % 9)}-${String(1 + (i % 28)).padStart(2, '0')}`,
          'type: nota',
          `summary: "Nota de relleno numero ${i} sin relacion con la tarea principal"`,
          'tags:',
          `  - tema/${topic}`,
          '  - chamba',
          `keywords: [relleno, nota, numero-${i}]`,
          'related: []',
          'temas_propuestos: []',
          'source: chamba',
          '---',
          `# Nota de ruido ${i}`,
        ].join('\n'),
      );
    }

    // Run reindexer to generate root INDEX.md and hubs
    const reindexer = new VaultReindexer(fs, '/vault');
    await reindexer.reindex({ dryRun: false });

    // Load all notes from the vault
    const { vocabulary } = parseVocabulary(vocabContent);
    const notes: GraphNote[] = [];
    async function scanDir(dir: string): Promise<void> {
      const entries = await fs.readDir(dir);
      for (const entry of entries) {
        const fullPath = `${dir}/${entry.name}`;
        if (entry.isDirectory) {
          if (!['temas', '.obsidian', '.trash'].includes(entry.name)) {
            await scanDir(fullPath);
          }
        } else if (
          entry.name.endsWith('.md') &&
          entry.name !== 'INDEX.md' &&
          entry.name !== 'VOCABULARIO.md'
        ) {
          try {
            const content = await fs.readFile(fullPath);
            const relPath = fullPath.startsWith('/vault/')
              ? fullPath.slice('/vault/'.length)
              : fullPath;
            const metadata = readNoteMetadata(content, relPath);
            // Only include non-generated notes
            if (!metadata.generated) {
              notes.push({ path: relPath, metadata });
            }
          } catch {
            // skip
          }
        }
      }
    }
    await scanDir('/vault');

    // Verify we have 200 notes (3 expected + 197 noise)
    expect(notes.length).toBe(200);

    // Build the context map
    const { mapa } = buildContextMap(notes, vocabulary ?? null, TASK_TERMS, { maxTokens: 2000 });

    // Check that the map contains the expected high-scoring notes
    const allMapNotePaths = mapa.nodos.flatMap((n) => n.notas.map((note) => note.ruta));

    for (const expectedPath of EXPECTED_PATHS) {
      expect(allMapNotePaths).toContain(expectedPath);
    }

    // Test 5 assertion: simulating the prompt walk
    // Notes that contain task terms in summary/keywords ≤ 8 "bodies to read"
    // (The map offers ≤ 3 nodes × 5 = 15 notes max, filtered to those with relevant summaries)
    const relevantForBodyRead = allMapNotePaths.filter((p) => {
      const note = notes.find((n) => n.path === p);
      if (!note) return false;
      const text =
        `${note.metadata.summary ?? ''} ${note.metadata.keywords.join(' ')}`.toLowerCase();
      return ['editar', 'cursos', 'insignias', 'endpoint', 'otorgar'].some((term) =>
        text.includes(term),
      );
    });
    // Should be ≤ 8 (the 3 planted notes + possibly a few noise notes that happen to match)
    expect(relevantForBodyRead.length).toBeLessThanOrEqual(8);
    // All 3 expected paths should be in the relevant-for-body-read set
    for (const expectedPath of EXPECTED_PATHS) {
      expect(relevantForBodyRead).toContain(expectedPath);
    }
  });
});

describe('buildContextMap — work item note already under a topic', () => {
  it('is referenced in the work item group, not repeated in full', () => {
    const notes = loadFixtureNotes();
    const { vocabulary } = loadFixtureVocab();
    const { section, mapa } = buildContextMap(
      notes,
      vocabulary ?? null,
      'endpoint para editar cursos y otorgar insignias en LMS API hu-lms-api-01',
      { maxTokens: 2000 },
    );
    const ruta = 'proyectos/hu-lms-api-01-cursos-modulos.md';
    expect(mapa.nodos.flatMap((n) => n.notas.map((x) => x.ruta))).toContain(ruta);
    expect(mapa.workItems[0]?.notas.map((x) => x.ruta)).toEqual([ruta]);
    expect(section).toContain(`(${ruta}) (listada arriba)`);
    expect(section.split(`(${ruta})`).length - 1).toBe(2);
    expect(section.split('Endpoints de creación y gestión de cursos/módulos').length - 1).toBe(1);
  });
});

// ─── Section order ────────────────────────────────────────────────────────────

describe('buildContextMap — section structure', () => {
  it('section starts with ## Mapa del vault and ends with navigation hint', () => {
    const notes = loadFixtureNotes();
    const { vocabulary } = loadFixtureVocab();
    const { section } = buildContextMap(notes, vocabulary ?? null, 'endpoint para editar cursos', {
      maxTokens: 2000,
    });

    expect(section.startsWith('## Mapa del vault')).toBe(true);
    expect(section).toContain('chamba_vault_navigate');
    // Navigation hint is at the end
    const lines = section.split('\n');
    const lastMeaningfulLine = [...lines].reverse().find((l) => l.trim().length > 0) ?? '';
    expect(lastMeaningfulLine).toContain('chamba_vault_navigate');
  });

  it('no nodes when task has no matching keywords', () => {
    const notes = loadFixtureNotes();
    const { vocabulary } = loadFixtureVocab();
    const { mapa } = buildContextMap(notes, vocabulary ?? null, 'xyz123 totally unrelated query', {
      maxTokens: 2000,
    });

    expect(mapa.nodos).toHaveLength(0);
    expect(mapa.workItems).toHaveLength(0);
  });
});

// ─── M5: work_item matching is case-insensitive ───────────────────────────────

describe('buildContextMap — M5: case-insensitive work_item matching', () => {
  it('matches work_item HU-LMS-API-01 when task mentions hu-lms-api-01 (lowercase)', () => {
    // Note has uppercase work_item; task mentions the same ID in lowercase.
    const noteContent = [
      '---',
      'title: "Plan API uppercase"',
      'date: 2026-10-01',
      'type: plan',
      'summary: "Plan for LMS API"',
      'tags:',
      '  - tema/lms',
      'keywords: [lms, api]',
      'work_item: HU-LMS-API-01',
      'source: human',
      '---',
      '# Plan',
    ].join('\n');

    const notes: GraphNote[] = [
      { path: 'planes/plan-01.md', metadata: readNoteMetadata(noteContent, 'planes/plan-01.md') },
    ];

    // Task mentions the ID in lowercase
    const task = 'implement endpoints for hu-lms-api-01 user story';
    const { mapa } = buildContextMap(notes, null, task, { maxTokens: 2000 });

    expect(mapa.workItems).toHaveLength(1);
    // ID in result preserves the original case from the note
    expect(mapa.workItems[0]?.id).toBe('HU-LMS-API-01');
    expect(mapa.workItems[0]?.notas[0]?.ruta).toBe('planes/plan-01.md');
  });

  it('also matches when task has uppercase and note has lowercase work_item', () => {
    const noteContent = [
      '---',
      'title: "Plan API lowercase"',
      'date: 2026-10-01',
      'type: plan',
      'summary: "Plan for LMS API"',
      'tags:',
      '  - tema/lms',
      'keywords: [lms, api]',
      'work_item: hu-lms-api-01',
      'source: human',
      '---',
      '# Plan',
    ].join('\n');

    const notes: GraphNote[] = [
      { path: 'planes/plan-01.md', metadata: readNoteMetadata(noteContent, 'planes/plan-01.md') },
    ];

    // Task mentions the ID in uppercase — WORK_ITEM_RE is /gi so it matches,
    // then lowercased for comparison.
    const task = 'implement endpoints for HU-LMS-API-01 user story';
    const { mapa } = buildContextMap(notes, null, task, { maxTokens: 2000 });

    expect(mapa.workItems).toHaveLength(1);
    expect(mapa.workItems[0]?.id).toBe('hu-lms-api-01');
    expect(mapa.workItems[0]?.notas[0]?.ruta).toBe('planes/plan-01.md');
  });
});
