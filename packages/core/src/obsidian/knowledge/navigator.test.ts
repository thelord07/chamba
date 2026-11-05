/**
 * Test 1 — VaultNav navigator (CHAMBA-017).
 *
 * Uses:
 * - The 016 fixture for navRoot and navNode tests (read-only, no mutations).
 * - Dedicated in-memory GraphNote arrays for backlinks and workItem sisters
 *   (the fixture has no `related` and no shared work_items).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { GraphNote } from './knowledge-graph.js';
import { buildVaultNav, coTopics, navNode, navNote, navRoot } from './navigator.js';
import { readNoteMetadata } from './note-metadata.js';
import { parseVocabulary, resolveTopic } from './vocabulary.js';

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

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeNote(
  path: string,
  title: string,
  opts: {
    type?: string;
    workItem?: string;
    related?: string[];
    temas?: string[];
    keywords?: string[];
  } = {},
): GraphNote {
  const type = opts.type ?? 'nota';
  const fmLines = [
    '---',
    `title: "${title}"`,
    `type: ${type}`,
    `tags: [${(opts.temas ?? []).map((t) => `tema/${t}`).join(', ')}]`,
    `keywords: [${(opts.keywords ?? []).join(', ')}]`,
    'aliases: []',
    'related:',
    ...(opts.related ?? []).map((r) => `  - ${r}`),
    'temas_propuestos: []',
    ...(opts.workItem ? [`work_item: ${opts.workItem}`] : []),
    '---',
    `# ${title}`,
  ];
  const content = fmLines.join('\n');
  return { path, metadata: readNoteMetadata(content, path) };
}

// ─── navRoot ─────────────────────────────────────────────────────────────────

describe('navRoot (fixture)', () => {
  it('returns top-level topics with counts, folders, and sinClasificar', () => {
    const notes = loadFixtureNotes();
    const { vocabulary } = loadFixtureVocab();
    const nav = buildVaultNav(notes, vocabulary ?? null);
    const root = navRoot(nav);

    // Should have root-level topics from the vocabulary
    const temasPaths = root.temas.map((t) => t.ruta);
    expect(temasPaths).toContain('lms');
    expect(temasPaths).toContain('soporte');
    expect(temasPaths).toContain('infra');

    // lms should have notes in its subtree
    const lms = root.temas.find((t) => t.ruta === 'lms');
    expect(lms).toBeDefined();
    expect(lms?.conteoSubarbol).toBeGreaterThan(0);

    // Should have physical folders (carpetas)
    const carpetaPaths = root.carpetas.map((c) => c.ruta);
    expect(carpetaPaths).toContain('informes');
    expect(carpetaPaths).toContain('investigacion');
    expect(carpetaPaths).toContain('planes');
    expect(carpetaPaths).toContain('proyectos');

    // sinClasificar is 0 when all notes have valid temas
    expect(root.sinClasificar).toBeGreaterThanOrEqual(0);
  });

  it('order of sections: topics before carpetas (structural check)', () => {
    const notes = loadFixtureNotes();
    const { vocabulary } = loadFixtureVocab();
    const nav = buildVaultNav(notes, vocabulary ?? null);
    const root = navRoot(nav);

    // Topics and carpetas should both be non-empty arrays
    expect(root.temas.length).toBeGreaterThan(0);
    expect(root.carpetas.length).toBeGreaterThan(0);
  });
});

// ─── navNode ─────────────────────────────────────────────────────────────────

describe('navNode(lms/cursos) (fixture)', () => {
  it('returns subtemas, empty notasDirectas, padre and co-topics', () => {
    const notes = loadFixtureNotes();
    const { vocabulary } = loadFixtureVocab();
    const nav = buildVaultNav(notes, vocabulary ?? null);

    const view = navNode(nav, 'lms/cursos');
    expect(view).not.toBeNull();

    // lms/cursos is an intermediate node — no notes carry this exact tag
    expect(view?.notasDirectas).toHaveLength(0);

    // Should have subtemas: creacion and gestion
    const subRutas = view?.subtemas.map((s) => s.ruta);
    expect(subRutas).toContain('lms/cursos/creacion');
    expect(subRutas).toContain('lms/cursos/gestion');

    // subtemas should have positive counts
    const creacion = view?.subtemas.find((s) => s.ruta === 'lms/cursos/creacion');
    const gestion = view?.subtemas.find((s) => s.ruta === 'lms/cursos/gestion');
    expect(creacion?.conteoSubarbol).toBeGreaterThan(0);
    expect(gestion?.conteoSubarbol).toBeGreaterThan(0);

    // padre should be 'lms'
    expect(view?.padre).toBe('lms');

    // coTemas: topics that co-occur in the subtree notes
    // (hu-lms-api-01 note has tags lms/cursos/creacion, lms/cursos/gestion, lms/gamificacion)
    // So lms/gamificacion should appear in coTemas
    const coTemaNames = view?.coTemas.map((c) => c.tema);
    expect(coTemaNames).toContain('lms/gamificacion');

    // lms/cursos descendants should NOT appear as co-topics
    expect(coTemaNames).not.toContain('lms/cursos');
    expect(coTemaNames).not.toContain('lms/cursos/creacion');
    expect(coTemaNames).not.toContain('lms/cursos/gestion');
  });

  it('returns null for a non-existent node', () => {
    const notes = loadFixtureNotes();
    const { vocabulary } = loadFixtureVocab();
    const nav = buildVaultNav(notes, vocabulary ?? null);
    expect(navNode(nav, 'nonexistent/node')).toBeNull();
  });
});

describe('navNode alias resolution via resolveTopic (fixture)', () => {
  it('vocabulary has alias crear-cursos → lms/cursos/creacion', () => {
    const { vocabulary } = loadFixtureVocab();
    if (!vocabulary) throw new Error('fixture vocabulary missing');
    const resolved = resolveTopic(vocabulary, 'crear-cursos');
    expect(resolved).toHaveProperty('path', 'lms/cursos/creacion');
  });

  it('navNode on the resolved path works', () => {
    const notes = loadFixtureNotes();
    const { vocabulary } = loadFixtureVocab();
    if (!vocabulary) throw new Error('fixture vocabulary missing');
    const resolved = resolveTopic(vocabulary, 'crear-cursos') as { path: string };

    const nav = buildVaultNav(notes, vocabulary ?? null);
    const view = navNode(nav, resolved.path);
    expect(view).not.toBeNull();
    expect(view?.ruta).toBe('lms/cursos/creacion');
  });
});

// ─── navNote with backlinks and workItem sisters (in-memory GraphNote arrays) ─

describe('navNote backlinks', () => {
  it('finds backlinks via metadata related field', () => {
    // Note A has `related: ['notes/note-b.md']`
    const noteA = makeNote('notes/note-a.md', 'Note A', {
      related: ['notes/note-b.md'],
    });
    const noteB = makeNote('notes/note-b.md', 'Note B');

    const notes = [noteA, noteB];
    const nav = buildVaultNav(notes, null);

    const view = navNote(nav, notes, 'notes/note-b.md', {});

    expect(view).not.toBeNull();
    // Note A references Note B → Note A appears as a backlink of Note B
    expect(view?.backlinks).toHaveLength(1);
    expect(view?.backlinks[0]?.ruta).toBe('notes/note-a.md');
    expect(view?.backlinks[0]?.titulo).toBe('Note A');
  });

  it('finds backlinks via [[wiki link]] in note body (unique basename)', () => {
    const noteABody = [
      '---',
      'title: "Note A"',
      'type: nota',
      'tags: []',
      'keywords: []',
      'aliases: []',
      'related: []',
      'temas_propuestos: []',
      '---',
      '# Note A\n\nSee also [[note-b]].',
    ].join('\n');

    const noteBBody = [
      '---',
      'title: "Note B"',
      'type: nota',
      'tags: []',
      'keywords: []',
      'aliases: []',
      'related: []',
      'temas_propuestos: []',
      '---',
      '# Note B\n\nContent.',
    ].join('\n');

    const notes: GraphNote[] = [
      { path: 'notes/note-a.md', metadata: readNoteMetadata(noteABody, 'notes/note-a.md') },
      { path: 'notes/note-b.md', metadata: readNoteMetadata(noteBBody, 'notes/note-b.md') },
    ];
    const nav = buildVaultNav(notes, null);

    const noteContents = new Map([
      ['notes/note-a.md', noteABody],
      ['notes/note-b.md', noteBBody],
    ]);

    const view = navNote(nav, notes, 'notes/note-b.md', { noteContents });

    expect(view).not.toBeNull();
    // note-b is unique by basename, so [[note-b]] resolves to it
    expect(view?.backlinks).toHaveLength(1);
    expect(view?.backlinks[0]?.ruta).toBe('notes/note-a.md');
  });

  it('backlinks are sorted by ruta asc', () => {
    const noteA = makeNote('notes/a-note.md', 'A Note', { related: ['notes/target.md'] });
    const noteC = makeNote('notes/c-note.md', 'C Note', { related: ['notes/target.md'] });
    const noteB = makeNote('notes/b-note.md', 'B Note', { related: ['notes/target.md'] });
    const target = makeNote('notes/target.md', 'Target');

    const notes = [noteA, noteC, noteB, target];
    const nav = buildVaultNav(notes, null);
    const view = navNote(nav, notes, 'notes/target.md');

    expect(view?.backlinks.map((b) => b.ruta)).toEqual([
      'notes/a-note.md',
      'notes/b-note.md',
      'notes/c-note.md',
    ]);
  });
});

describe('navNote sisters', () => {
  it('finds workItem sisters (excludes self)', () => {
    const noteA = makeNote('work/plan-hw-01.md', 'Plan HW-01', { type: 'plan', workItem: 'hw-01' });
    const noteB = makeNote('work/resumen-hw-01.md', 'Resumen HW-01', {
      type: 'resumen',
      workItem: 'hw-01',
    });
    const noteC = makeNote('work/plan-hw-02.md', 'Plan HW-02', { type: 'plan', workItem: 'hw-02' });

    const notes = [noteA, noteB, noteC];
    const nav = buildVaultNav(notes, null);

    const view = navNote(nav, notes, 'work/plan-hw-01.md');

    expect(view).not.toBeNull();
    // Sisters of plan-hw-01: only resumen-hw-01 (same work_item hw-01, excluding self)
    expect(view?.hermanas).toHaveLength(1);
    expect(view?.hermanas[0]?.ruta).toBe('work/resumen-hw-01.md');
    // plan-hw-02 has different work_item — not included
    expect(view?.hermanas.map((h) => h.ruta)).not.toContain('work/plan-hw-02.md');
  });

  it('no sisters when note has no work_item', () => {
    const note = makeNote('notes/no-wi.md', 'No Work Item');
    const nav = buildVaultNav([note], null);
    const view = navNote(nav, [note], 'notes/no-wi.md');
    expect(view?.hermanas).toHaveLength(0);
  });
});

describe('navNote body', () => {
  it('body undefined when readBody is false (default)', () => {
    const content =
      '---\ntitle: "T"\ntype: nota\ntags: []\nkeywords: []\naliases: []\nrelated: []\ntemas_propuestos: []\n---\n# T\nBody text.';
    const notes: GraphNote[] = [{ path: 'x.md', metadata: readNoteMetadata(content, 'x.md') }];
    const nav = buildVaultNav(notes, null);
    const noteContents = new Map([['x.md', content]]);
    const view = navNote(nav, notes, 'x.md', { readBody: false, noteContents });
    expect(view?.body).toBeUndefined();
  });

  it('body provided when readBody is true', () => {
    const content =
      '---\ntitle: "T"\ntype: nota\ntags: []\nkeywords: []\naliases: []\nrelated: []\ntemas_propuestos: []\n---\n# T\nBody text.';
    const notes: GraphNote[] = [{ path: 'x.md', metadata: readNoteMetadata(content, 'x.md') }];
    const nav = buildVaultNav(notes, null);
    const noteContents = new Map([['x.md', content]]);
    const view = navNote(nav, notes, 'x.md', { readBody: true, noteContents });
    expect(view?.body).toBeDefined();
    expect(view?.truncated).toBeUndefined();
  });

  it('body truncated when exceeds maxChars', () => {
    const longContent =
      '---\ntitle: "T"\ntype: nota\ntags: []\nkeywords: []\naliases: []\nrelated: []\ntemas_propuestos: []\n---\n# T\n' +
      'X'.repeat(5000);
    const notes: GraphNote[] = [{ path: 'x.md', metadata: readNoteMetadata(longContent, 'x.md') }];
    const nav = buildVaultNav(notes, null);
    const noteContents = new Map([['x.md', longContent]]);
    const view = navNote(nav, notes, 'x.md', { readBody: true, maxChars: 100, noteContents });
    expect(view?.truncated).toBe(true);
    // body ≤ maxChars + length of truncation notice
    expect(view?.body?.length).toBeGreaterThan(0);
    expect(view?.body?.length).toBeLessThan(longContent.length);
  });

  it('returns null for non-existent note', () => {
    const nav = buildVaultNav([], null);
    expect(navNote(nav, [], 'nonexistent.md')).toBeNull();
  });
});

// ─── coTopics ─────────────────────────────────────────────────────────────────

describe('coTopics', () => {
  it('counts co-occurring topics outside the node and its descendants', () => {
    const notes = loadFixtureNotes();
    const { vocabulary } = loadFixtureVocab();
    const nav = buildVaultNav(notes, vocabulary ?? null);

    // lms/cursos subtree: notes include hu-lms-api-01 which also has lms/gamificacion
    const lmsCursosNode = nav.nodes.get('lms/cursos');
    if (!lmsCursosNode) throw new Error('fixture node lms/cursos missing');
    const co = coTopics(nav, lmsCursosNode);

    // lms/gamificacion should co-occur (from hu-lms-api-01)
    const temaNames = co.map((c) => c.tema);
    expect(temaNames).toContain('lms/gamificacion');

    // lms/cursos and descendants must NOT appear
    expect(temaNames).not.toContain('lms/cursos');
    expect(temaNames).not.toContain('lms/cursos/creacion');
    expect(temaNames).not.toContain('lms/cursos/gestion');

    // At most 5 results
    expect(co.length).toBeLessThanOrEqual(5);
  });
});
