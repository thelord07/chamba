/**
 * Tests for topics.ts — tests 6, 7, 8 and O3 from CHAMBA-016 spec.
 *
 * Test 6: VaultWriter with vocabulary
 * Test 7: promotePlan / applyPromote
 * Test 8: bootstrapStats + writeVocabulary guard
 * O3: VaultWriter without vocabulary
 */

import { describe, expect, it } from 'vitest';
import type { ClockPort } from '../../ports/clock.js';
import { MemoryFilesystem } from '../../testing/memory-filesystem.js';
import { VaultWriter } from '../vault-writer.js';
import { readNoteMetadata } from './note-metadata.js';
import {
  applyPromote,
  bootstrapStats,
  closestTopics,
  compactTopicTree,
  promotePlan,
  renderVocabulary,
  vocabularyAdd,
  vocabularyAlias,
  writeVocabulary,
} from './topics.js';
import { parseVocabulary } from './vocabulary.js';

const fixedClock: ClockPort = {
  now: () => new Date('2026-11-01T00:00:00Z'),
  today: () => '2026-11-01',
};

// ─── Shared fixture ───────────────────────────────────────────────────────────

const VOCAB_CONTENT = `---
title: "Vocabulario de temas"
source: human
umbral_promover: 3
umbral_dividir: 25
generar_bases: true
---
# Vocabulario de temas

- \`lms\` — LMS de Lapzo. Alias: plataforma
  - \`lms/cursos\` — Cursos y su ciclo de vida.
    - \`lms/cursos/creacion\` — Alta de cursos, módulos y lecciones. Alias: crear-cursos
    - \`lms/cursos/gestion\` — Edición, publicación, archivado.
  - \`lms/gamificacion\` — Puntos, insignias, rankings. Alias: gamification
- \`soporte\` — Bugs y tareas de soporte CyA.
  - \`soporte/bugs\` — Errores reportados por clientes.
- \`infra\` — Infraestructura y DevOps.
`;

function makeVaultFs(extraFiles: Record<string, string> = {}): MemoryFilesystem {
  return new MemoryFilesystem({
    '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT,
    ...extraFiles,
  });
}

// ─── Test 6: VaultWriter with vocabulary ─────────────────────────────────────

describe('Test 6 — VaultWriter with vocabulary', () => {
  it('alias → canonical path in tags', async () => {
    const fs = makeVaultFs();
    const writer = new VaultWriter(fs, fixedClock);
    const result = await writer.write({
      vaultPath: '/vault',
      title: 'Nota de gamificación',
      content: 'Body content',
      summary: 'Sobre puntos e insignias',
      temas: ['gamification'], // alias, should resolve to lms/gamificacion
    });

    expect(result.temasAplicados).toContain('lms/gamificacion');
    expect(result.temasPropuestos).toHaveLength(0);

    const note = await fs.readFile(result.notePath);
    expect(note).toContain('tema/lms/gamificacion');
    expect(note).not.toContain('tema/gamification');
  });

  it('unknown topic → temas_propuestos + suggestion, note is written', async () => {
    const fs = makeVaultFs();
    const writer = new VaultWriter(fs, fixedClock);
    const result = await writer.write({
      vaultPath: '/vault',
      title: 'Nota sobre certificados',
      content: 'Body',
      summary: 'Certificados digitales',
      temas: ['lms/certificados'], // unknown, closest might be lms/cursos
    });

    expect(result.temasPropuestos).toContain('lms/certificados');
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain('temas_propuestos');

    // Note is still written
    const note = await fs.readFile(result.notePath);
    expect(note).toBeTruthy();
    expect(note).toContain('lms/certificados'); // in temas_propuestos
  });

  it('no valid temas → unclassified + warning', async () => {
    const fs = makeVaultFs();
    const writer = new VaultWriter(fs, fixedClock);
    const result = await writer.write({
      vaultPath: '/vault',
      title: 'Nota sin temas válidos',
      content: 'Body',
      temas: ['xyz/unknown/path', 'abc/def'],
    });

    expect(result.temasAplicados).toHaveLength(0);
    expect(result.temasPropuestos.length).toBeGreaterThan(0);
    // warning about no valid temas
    const hasUnclassifiedWarn = result.warnings.some(
      (w) => w.includes('sin clasificar') || w.includes('temas_propuestos'),
    );
    expect(hasUnclassifiedWarn).toBe(true);
  });

  it('response includes compactTopicTree (arbol) and 5 closest nodes (cercanos)', async () => {
    const fs = makeVaultFs();
    const writer = new VaultWriter(fs, fixedClock);
    const result = await writer.write({
      vaultPath: '/vault',
      title: 'LMS cursos nota',
      content: 'Body',
      summary: 'Gestión de cursos en la plataforma',
      temas: ['lms/cursos'],
    });

    expect(typeof result.arbol).toBe('string');
    expect(result.arbol.length).toBeGreaterThan(0);
    expect(result.cercanos).toHaveLength(5);
    expect(result.cercanos[0]).toHaveProperty('path');
    expect(result.cercanos[0]).toHaveProperty('score');
  });

  it('tags tema/a/b/c are NOT slugified (slashes preserved)', async () => {
    const fs = makeVaultFs();
    const writer = new VaultWriter(fs, fixedClock);
    const result = await writer.write({
      vaultPath: '/vault',
      title: 'Deep topic note',
      content: 'Body',
      temas: ['lms/cursos/creacion'],
    });

    const note = await fs.readFile(result.notePath);
    // Must contain the full path with slashes, NOT slugified (no tema-lms-cursos-creacion)
    expect(note).toContain('tema/lms/cursos/creacion');
    expect(note).not.toContain('tema-lms-cursos-creacion');
  });

  it('work_item links plan↔resumen and never edits a human note of same work_item', async () => {
    const humanNoteContent = `---
title: "Nota humana"
date: 2026-10-01
work_item: hu-test-01
tags:
  - chamba
---
Nota escrita por el humano.
`;
    const chambaNote1Content = `---
title: "Plan HU Test 01"
date: 2026-10-02
type: plan
work_item: hu-test-01
source: chamba
tags:
  - chamba
---
El plan.
`;

    const fs = makeVaultFs({
      '/vault/proyectos/nota-humana.md': humanNoteContent,
      '/vault/planes/plan-hu-test-01.md': chambaNote1Content,
    });

    const writer = new VaultWriter(fs, fixedClock);
    const result = await writer.write({
      vaultPath: '/vault',
      title: 'Resumen HU Test 01',
      content: 'El resumen.',
      workItem: 'hu-test-01',
      type: 'resumen',
    });

    // New note should have related pointing to existing notes
    const newNote = await fs.readFile(result.notePath);
    expect(newNote).toContain('planes/plan-hu-test-01.md');

    // The human note should NOT be modified
    const humanNoteAfter = await fs.readFile('/vault/proyectos/nota-humana.md');
    expect(humanNoteAfter).toBe(humanNoteContent);

    // The chamba plan should be updated with back-link (source: chamba)
    const chambaNote1After = await fs.readFile('/vault/planes/plan-hu-test-01.md');
    // Should have related added
    expect(chambaNote1After).toContain('2026-11-01'); // new note date
  });
});

// ─── Test 7: promotePlan / applyPromote ───────────────────────────────────────

describe('Test 7 — promotePlan / applyPromote', () => {
  it('proposed topic with 3+ notes → readyToPromote', async () => {
    const fs = makeVaultFs({
      '/vault/notas/nota-a.md': `---
title: "Nota A"
temas_propuestos: [lms/contenido]
source: chamba
tags: [chamba]
---
Body`,
      '/vault/notas/nota-b.md': `---
title: "Nota B"
temas_propuestos: [lms/contenido]
source: chamba
tags: [chamba]
---
Body`,
      '/vault/notas/nota-c.md': `---
title: "Nota C"
temas_propuestos: [lms/contenido]
source: chamba
tags: [chamba]
---
Body`,
    });

    const plan = await promotePlan(fs, '/vault', 'lms/contenido');
    expect(plan.diffs).toHaveLength(3);
    // Each diff should move lms/contenido from temas_propuestos to tags
    for (const diff of plan.diffs) {
      expect(diff.after.tags).toContain('tema/lms/contenido');
      expect(diff.after.temas_propuestos).not.toContain('lms/contenido');
    }
  });

  it('promotePlan dryRun (plan only) — does NOT write files', async () => {
    const original = `---
title: "Nota prop"
temas_propuestos: [lms/certificados]
source: chamba
tags: [chamba]
---
Body`;
    const fs = makeVaultFs({ '/vault/notas/nota.md': original });
    const plan = await promotePlan(fs, '/vault', 'lms/certificados');
    expect(plan.diffs).toHaveLength(1);
    // File not modified
    const after = await fs.readFile('/vault/notas/nota.md');
    expect(after).toBe(original);
  });

  it('applyPromote moves tema from temas_propuestos to tags and adds node to vocab', async () => {
    const noteContent = `---
title: "Nota cert"
temas_propuestos: [lms/certificados]
source: chamba
tags: [chamba]
---
Body content here.`;
    const fs = makeVaultFs({ '/vault/notas/nota-cert.md': noteContent });

    const plan = await promotePlan(fs, '/vault', 'lms/certificados');
    const result = await applyPromote(
      fs,
      '/vault',
      'lms/certificados',
      plan.diffs,
      VOCAB_CONTENT,
      'Certificados digitales del LMS',
    );

    expect(result.vocabularyUpdated).toBe(true);
    expect(result.written).toContain('notas/nota-cert.md');

    // Verify note updated: body intact
    const noteAfter = await fs.readFile('/vault/notas/nota-cert.md');
    expect(noteAfter).toContain('Body content here.');
    expect(noteAfter).toContain('tema/lms/certificados');
    // temas_propuestos no longer contains it
    const meta = readNoteMetadata(noteAfter, 'notas/nota-cert.md');
    expect(meta.temas_propuestos).not.toContain('lms/certificados');
    expect(meta.tags).toContain('tema/lms/certificados');

    // Vocabulary updated with new node
    const vocabAfter = await fs.readFile('/vault/temas/VOCABULARIO.md');
    expect(vocabAfter).toContain('lms/certificados');
  });

  it('applyPromote fails if parent not in vocabulary', async () => {
    const fs = makeVaultFs();
    const result = await applyPromote(
      fs,
      '/vault',
      'unknown-root/child',
      [],
      VOCAB_CONTENT,
      'Nodo sin padre',
    );
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('padre');
  });

  it('proposal at edit distance 1 from existing alias → suggestion in computeSuggestions', async () => {
    // This test is actually covered by knowledge-graph.test.ts (computeSuggestions).
    // Here we verify that closestTopics returns nearby matches for a query.
    const { vocabulary } = parseVocabulary(VOCAB_CONTENT);
    const closest = closestTopics(vocabulary, { title: 'gamificacion puntos' });
    const paths = closest.map((c) => c.path);
    expect(paths).toContain('lms/gamificacion');
  });
});

// ─── Test 8: bootstrapStats + writeVocabulary ─────────────────────────────────

describe('Test 8 — bootstrapStats + writeVocabulary', () => {
  const vaultFiles: Record<string, string> = {
    '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT,
    '/vault/proyectos/hu-lms-01.md': `---
title: "HU LMS 01"
tags: [tema/lms/cursos/creacion, chamba]
summary: "Creación de cursos en el LMS"
keywords: [cursos, api, creacion]
work_item: hu-lms-01
source: chamba
---
# HU LMS 01
Creación de cursos.`,
    '/vault/proyectos/hu-lms-02.md': `---
title: "HU LMS 02"
tags: [tema/lms/gamificacion, chamba]
summary: "Gamificación de la plataforma"
keywords: [gamificacion, puntos]
source: chamba
---
# HU LMS 02
Gamificación.`,
    '/vault/informes/informe-bugs.md': `---
title: "Informe Bugs Octubre"
tags: [tema/soporte/bugs, chamba]
summary: "Bugs reportados en octubre"
work_item: cu-abc1234
source: chamba
---
# Informe Bugs
Bugs del mes.`,
  };

  it('bootstrapStats is deterministic (two calls yield identical results)', async () => {
    const fs = new MemoryFilesystem(vaultFiles);
    const stats1 = await bootstrapStats(fs, '/vault');
    const stats2 = await bootstrapStats(fs, '/vault');

    expect(JSON.stringify(stats1)).toBe(JSON.stringify(stats2));
  });

  it('bootstrapStats counts folders correctly', async () => {
    const fs = new MemoryFilesystem(vaultFiles);
    const stats = await bootstrapStats(fs, '/vault');
    const folderPaths = stats.folders.map((f) => f.path);
    expect(folderPaths).toContain('proyectos');
    expect(folderPaths).toContain('informes');
  });

  it('bootstrapStats finds work_items in filenames', async () => {
    const fs = new MemoryFilesystem(vaultFiles);
    const stats = await bootstrapStats(fs, '/vault');
    const ids = stats.workItems.map((w) => w.id);
    // hu-lms-01 from filename
    expect(ids.some((id) => id.includes('lms') || id.includes('hu'))).toBe(true);
  });

  it('bootstrapStats collects existing tags', async () => {
    const fs = new MemoryFilesystem(vaultFiles);
    const stats = await bootstrapStats(fs, '/vault');
    const tags = stats.tags.map((t) => t.tag);
    expect(tags).toContain('chamba');
    expect(tags).toContain('tema/lms/cursos/creacion');
  });

  it('writeVocabulary refuses to overwrite without replace: true', async () => {
    const fs = makeVaultFs();
    const result = await writeVocabulary(fs, '/vault', 'new content', { replace: false });
    expect(result.written).toBe(false);
    expect(result.error).toContain('replace');
    // File unchanged
    const after = await fs.readFile('/vault/temas/VOCABULARIO.md');
    expect(after).toBe(VOCAB_CONTENT);
  });

  it('writeVocabulary dryRun returns content without writing', async () => {
    const fs = makeVaultFs();
    const newContent = `${VOCAB_CONTENT}\n- \`new-root\` — Nuevo nodo raíz.\n`;
    const result = await writeVocabulary(fs, '/vault', newContent, { dryRun: true });
    expect(result.written).toBe(false);
    expect(result.content).toBe(newContent);
    // File unchanged
    const after = await fs.readFile('/vault/temas/VOCABULARIO.md');
    expect(after).toBe(VOCAB_CONTENT);
  });

  it('writeVocabulary succeeds when replace: true', async () => {
    const fs = makeVaultFs();
    const { content: newContent } = renderVocabulary([
      { path: 'lms', description: 'LMS renovado' },
    ]);
    const result = await writeVocabulary(fs, '/vault', newContent ?? '', { replace: true });
    expect(result.written).toBe(true);
    const after = await fs.readFile('/vault/temas/VOCABULARIO.md');
    expect(after).toBe(newContent);
  });

  it('renderVocabulary validates and returns errors for invalid nodes', () => {
    const result = renderVocabulary([
      { path: 'lms', description: 'LMS' },
      { path: 'lms/INVALID SEGMENT', description: 'Invalid' }, // uppercase + space
    ]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.content).toBeNull();
  });

  it('renderVocabulary generates valid VOCABULARIO.md for valid nodes', () => {
    const result = renderVocabulary([
      { path: 'lms', description: 'LMS de Lapzo', aliases: ['plataforma'] },
      { path: 'lms/cursos', description: 'Cursos y su ciclo de vida' },
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.content).toContain('`lms`');
    expect(result.content).toContain('`lms/cursos`');
    expect(result.content).toContain('Alias: plataforma');
  });
});

// ─── Test O3: VaultWriter without vocabulary ──────────────────────────────────

describe('O3 — VaultWriter without vocabulary', () => {
  it('writes note with warning when no VOCABULARIO.md', async () => {
    const fs = new MemoryFilesystem({}); // no vocabulary
    const writer = new VaultWriter(fs, fixedClock);
    const result = await writer.write({
      vaultPath: '/vault',
      title: 'Nota sin vocab',
      content: 'Body',
      summary: 'Resumen',
      temas: ['lms/cursos'],
    });

    // Note is written
    const note = await fs.readFile(result.notePath);
    expect(note).toBeTruthy();

    // temas go to temas_propuestos
    expect(result.temasPropuestos).toContain('lms/cursos');
    expect(result.temasAplicados).toHaveLength(0);

    // Warning mentions missing vocabulary
    const hasVocabWarn = result.warnings.some(
      (w) => w.includes('VOCABULARIO.md') || w.includes('vocabulario') || w.includes('vocab'),
    );
    expect(hasVocabWarn).toBe(true);
  });

  it('writes note with "connect" warning when no summary/temas', async () => {
    const fs = new MemoryFilesystem({});
    const writer = new VaultWriter(fs, fixedClock);
    const result = await writer.write({
      vaultPath: '/vault',
      title: 'Nota básica',
      content: 'Body',
    });

    // Note is written
    expect(await fs.exists(result.notePath)).toBe(true);

    // Warning about connecting to the network
    const hasConnectWarn = result.warnings.some(
      (w) => w.includes('conéctala') || w.includes('summary') || w.includes('clasificar'),
    );
    expect(hasConnectWarn).toBe(true);
  });
});

// ─── compactTopicTree ────────────────────────────────────────────────────────

describe('compactTopicTree', () => {
  it('renders tree ≤ 60 lines', () => {
    const { vocabulary } = parseVocabulary(VOCAB_CONTENT);
    const tree = compactTopicTree(vocabulary);
    const lines = tree.trim().split('\n');
    expect(lines.length).toBeLessThanOrEqual(60);
    expect(tree).toContain('lms');
    expect(tree).toContain('soporte');
  });

  it('returns placeholder for empty vocabulary', () => {
    const emptyVocab = parseVocabulary('---\n---\n').vocabulary;
    const tree = compactTopicTree(emptyVocab);
    expect(tree).toContain('vacío');
  });

  it('includes counts when provided', () => {
    const { vocabulary } = parseVocabulary(VOCAB_CONTENT);
    const counts = new Map([['lms', 42]]);
    const tree = compactTopicTree(vocabulary, counts);
    expect(tree).toContain('42');
  });
});

// ─── vocabularyAdd / vocabularyAlias ─────────────────────────────────────────

describe('vocabularyAdd', () => {
  it('adds a root node preserving other content', () => {
    const result = vocabularyAdd(VOCAB_CONTENT, {
      path: 'analytics',
      description: 'Métricas y análisis',
    });
    expect(result.error).toBeUndefined();
    const { vocabulary } = parseVocabulary(result.content);
    expect(vocabulary.nodes.has('analytics')).toBe(true);
    expect(vocabulary.nodes.has('lms')).toBe(true); // existing
  });

  it('fails if parent missing', () => {
    const result = vocabularyAdd(VOCAB_CONTENT, {
      path: 'orphan/child',
      description: 'Nodo sin padre',
    });
    expect(result.error).toContain('padre');
  });

  it('fails if node already exists', () => {
    const result = vocabularyAdd(VOCAB_CONTENT, { path: 'lms', description: 'LMS dup' });
    expect(result.error).toContain('ya existe');
  });
});

describe('vocabularyAlias', () => {
  it('adds alias to existing node', () => {
    const result = vocabularyAlias(VOCAB_CONTENT, 'infra', 'devops');
    expect(result.error).toBeUndefined();
    const { vocabulary } = parseVocabulary(result.content);
    const node = vocabulary.nodes.get('infra');
    expect(node?.aliases).toContain('devops');
  });

  it('fails for duplicate alias', () => {
    const result = vocabularyAlias(VOCAB_CONTENT, 'lms/gamificacion', 'plataforma'); // plataforma already used by lms
    expect(result.error).toBeDefined();
  });

  it('fails for non-existent node', () => {
    const result = vocabularyAlias(VOCAB_CONTENT, 'nonexistent', 'alias');
    expect(result.error).toBeDefined();
  });
});

// ─── closestTopics ────────────────────────────────────────────────────────────

describe('closestTopics', () => {
  it('returns up to n results', () => {
    const { vocabulary } = parseVocabulary(VOCAB_CONTENT);
    const result = closestTopics(vocabulary, { title: 'LMS cursos' }, 3);
    expect(result).toHaveLength(3);
  });

  it('returns 5 by default', () => {
    const { vocabulary } = parseVocabulary(VOCAB_CONTENT);
    const result = closestTopics(vocabulary, { title: 'lms gamificacion cursos soporte infra' });
    expect(result).toHaveLength(5);
  });

  it('scores exact slug match higher', () => {
    const { vocabulary } = parseVocabulary(VOCAB_CONTENT);
    const result = closestTopics(vocabulary, { title: 'gamificacion puntos insignias' });
    expect(result[0]?.path).toBe('lms/gamificacion');
  });

  it('is deterministic (same inputs → same output)', () => {
    const { vocabulary } = parseVocabulary(VOCAB_CONTENT);
    const r1 = closestTopics(vocabulary, { title: 'infraestructura devops' });
    const r2 = closestTopics(vocabulary, { title: 'infraestructura devops' });
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});
