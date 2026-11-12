/**
 * Tests for classify.ts — test 9 from CHAMBA-016 spec.
 *
 * Test 9: classifyApply
 *   - Only changes the specified keys
 *   - Body byte-for-byte intact (including CRLF)
 *   - > 50 entries → rejection
 *   - dryRun (classifyPlan) does not write
 */

import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../../testing/memory-filesystem.js';
import { classifyApply, classifyPlan, listUnclassified } from './classify.js';
import { readNoteMetadata } from './note-metadata.js';

const PROVENANCE_OPTS = {
  author: 'Joys',
  version: '1.14.0',
  nowIso: '2026-01-01T00:00:00.000Z',
};

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
    - \`lms/cursos/creacion\` — Alta de cursos.
  - \`lms/gamificacion\` — Puntos, insignias, rankings.
- \`soporte\` — Bugs y tareas.
`;

// ─── Test 9 ───────────────────────────────────────────────────────────────────

describe('Test 9 — classifyApply', () => {
  it('only changes specified keys; body byte-for-byte intact', async () => {
    const body = 'This is the\r\nbody with\r\nCRLF line endings.\r\n';
    const original = `---\r\ntitle: "Nota original"\r\ndate: 2026-10-01\r\ntags:\r\n  - chamba\r\n---\r\n${body}`;

    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT,
      '/vault/notas/nota.md': original,
    });

    await classifyApply(fs, '/vault', [
      {
        path: 'notas/nota.md',
        temas: ['lms/cursos'],
        summary: 'Resumen actualizado',
      },
    ]);

    const updated = await fs.readFile('/vault/notas/nota.md');
    const meta = readNoteMetadata(updated, 'notas/nota.md');

    // New fields applied
    expect(meta.tags).toContain('tema/lms/cursos');
    expect(meta.summary).toBe('Resumen actualizado');

    // Body intact (CRLF preserved) — find where body starts after frontmatter close
    const fmEnd = updated.indexOf('---\r\n', 4); // find closing ---
    if (fmEnd !== -1) {
      const bodyInFile = updated.slice(fmEnd + 5); // skip "---\r\n"
      expect(bodyInFile).toBe(body);
    } else {
      // body must still contain original text
      expect(updated).toContain('CRLF line endings.');
    }

    // Other existing tags preserved (non-tema/)
    expect(meta.tags).toContain('chamba');
  });

  it('does not touch existing non-tema/ tags', async () => {
    const original = `---
title: "Nota"
tags:
  - custom-tag
  - another
---
Body here.`;

    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT,
      '/vault/notas/nota.md': original,
    });

    await classifyApply(fs, '/vault', [{ path: 'notas/nota.md', temas: ['lms/gamificacion'] }]);

    const updated = await fs.readFile('/vault/notas/nota.md');
    const meta = readNoteMetadata(updated, 'notas/nota.md');
    expect(meta.tags).toContain('custom-tag');
    expect(meta.tags).toContain('another');
    expect(meta.tags).toContain('tema/lms/gamificacion');
  });

  it('classifyPlan (dryRun) does not write files', async () => {
    const original = `---
title: "Nota dry"
tags: [chamba]
---
Body.`;

    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT,
      '/vault/notas/nota-dry.md': original,
    });

    const plan = await classifyPlan(fs, '/vault', [
      { path: 'notas/nota-dry.md', temas: ['lms/cursos'] },
    ]);

    expect(plan.diffs).toHaveLength(1);
    expect(plan.diffs[0]).toHaveProperty('before');
    expect(plan.diffs[0]).toHaveProperty('after');
    expect(plan.rejected).toHaveLength(0);

    // File NOT written
    const after = await fs.readFile('/vault/notas/nota-dry.md');
    expect(after).toBe(original);
  });

  it('rejects > 50 entries', async () => {
    const fs = new MemoryFilesystem({ '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT });
    const entries = Array.from({ length: 51 }, (_, i) => ({
      path: `notas/nota-${i}.md`,
      temas: ['lms'],
    }));

    await expect(classifyApply(fs, '/vault', entries)).rejects.toThrow(/50/);
    await expect(classifyPlan(fs, '/vault', entries)).rejects.toThrow(/50/);
  });

  it('rejects derived paths', async () => {
    const fs = new MemoryFilesystem({ '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT });
    const plan = await classifyPlan(fs, '/vault', [
      { path: 'temas/lms.md', temas: ['lms'] }, // derived
    ]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.reason).toContain('derivado');
  });

  it('rejects path traversal', async () => {
    const fs = new MemoryFilesystem({ '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT });
    const plan = await classifyPlan(fs, '/vault', [
      { path: '../../../etc/passwd', temas: ['lms'] },
    ]);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.reason).toContain('traversal');
  });

  it('resolves aliases in temas', async () => {
    const original = `---
title: "Nota"
tags: [chamba]
---
Body.`;

    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT,
      '/vault/notas/nota.md': original,
    });

    await classifyApply(fs, '/vault', [
      { path: 'notas/nota.md', temas: ['plataforma'] }, // alias for lms
    ]);

    const updated = await fs.readFile('/vault/notas/nota.md');
    const meta = readNoteMetadata(updated, 'notas/nota.md');
    expect(meta.tags).toContain('tema/lms');
  });

  it('unknown temas go to temas_propuestos', async () => {
    const original = `---
title: "Nota"
tags: [chamba]
---
Body.`;

    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT,
      '/vault/notas/nota.md': original,
    });

    await classifyApply(fs, '/vault', [{ path: 'notas/nota.md', temas: ['lms/desconocido'] }]);

    const updated = await fs.readFile('/vault/notas/nota.md');
    const meta = readNoteMetadata(updated, 'notas/nota.md');
    expect(meta.temas_propuestos).toContain('lms/desconocido');
  });
});

// ─── listUnclassified ────────────────────────────────────────────────────────

describe('listUnclassified', () => {
  it('returns notes without valid tema/ tags', async () => {
    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT,
      '/vault/notas/nota-clasificada.md': `---
title: "Clasificada"
tags:
  - tema/lms/cursos
---
Body.`,
      '/vault/notas/nota-sin-tema.md': `---
title: "Sin tema"
tags: [chamba]
---
Body sin clasificar.`,
    });

    const result = await listUnclassified(fs, '/vault');
    const paths = result.items.map((i) => i.path);
    expect(paths).toContain('notas/nota-sin-tema.md');
    expect(paths).not.toContain('notas/nota-clasificada.md');
  });

  it('paginates correctly', async () => {
    const files: Record<string, string> = {
      '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT,
    };
    for (let i = 0; i < 10; i++) {
      files[`/vault/notas/nota-${i}.md`] = `---\ntitle: "Nota ${i}"\ntags: [chamba]\n---\nBody.`;
    }
    const fs = new MemoryFilesystem(files);

    const page1 = await listUnclassified(fs, '/vault', { page: 1, pageSize: 5 });
    const page2 = await listUnclassified(fs, '/vault', { page: 2, pageSize: 5 });

    expect(page1.items).toHaveLength(5);
    expect(page2.items).toHaveLength(5);
    expect(page1.total).toBe(10);
    // No overlap
    const p1Paths = new Set(page1.items.map((i) => i.path));
    for (const item of page2.items) {
      expect(p1Paths.has(item.path)).toBe(false);
    }
  });

  it('firstParagraph is ≤ 300 chars', async () => {
    const longBody = 'x'.repeat(400);
    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT,
      '/vault/notas/nota-larga.md': `---\ntitle: "Nota"\ntags: [chamba]\n---\n${longBody}`,
    });

    const result = await listUnclassified(fs, '/vault');
    expect(result.items[0]?.firstParagraph.length).toBeLessThanOrEqual(300);
  });
});

// ─── M3: validateEntryPath rejects temas/ paths ──────────────────────────────

describe('M3: validateEntryPath rejects temas/', () => {
  it('classifyPlan rejects temas/VOCABULARIO.md', async () => {
    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT,
    });

    const result = await classifyPlan(fs, '/vault', [
      { path: 'temas/VOCABULARIO.md', temas: ['lms'] },
    ]);

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.path).toBe('temas/VOCABULARIO.md');
    expect(result.rejected[0]?.reason).toMatch(/temas\//);
  });

  it('classifyApply rejects any path under temas/', async () => {
    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT,
    });

    const result = await classifyApply(fs, '/vault', [
      { path: 'temas/otra-cosa.md', temas: ['lms'] },
    ]);

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.reason).toMatch(/temas\//);
  });

  it('classifyPlan does NOT reject a valid path (non-temas)', async () => {
    const noteContent = `---\ntitle: "Nota"\ndate: 2026-01-01\ntype: nota\ntags:\n  - chamba\nsource: chamba\n---\nContenido.\n`;
    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT,
      '/vault/notas/nota.md': noteContent,
    });

    const result = await classifyPlan(fs, '/vault', [{ path: 'notas/nota.md', temas: ['lms'] }]);

    // Should not be in rejected (may or may not have a diff)
    expect(result.rejected.find((r) => r.path === 'notas/nota.md')).toBeUndefined();
  });
});

describe('CHAMBA-021 D-Q4 — classifyApply provenance', () => {
  it('a chamba note gets author/agent/written_at filled (if missing) and estado: propuesto', async () => {
    const original = `---\ntitle: Nota\nsource: chamba\n---\nCuerpo.\n`;
    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT,
      '/vault/notas/nota.md': original,
    });

    await classifyApply(
      fs,
      '/vault',
      [{ path: 'notas/nota.md', temas: ['lms/cursos'] }],
      PROVENANCE_OPTS,
    );

    const meta = readNoteMetadata(await fs.readFile('/vault/notas/nota.md'), 'notas/nota.md');
    expect(meta.author).toBe('Joys');
    expect(meta.agent).toBe('chamba/classify@1.14.0');
    expect(meta.written_at).toBe('2026-01-01T00:00:00.000Z');
    expect(meta.estado).toBe('propuesto');
  });

  it('a chamba note with an existing author does not have it overwritten', async () => {
    const original = `---\ntitle: Nota\nsource: chamba\nauthor: Otra Persona\n---\nCuerpo.\n`;
    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT,
      '/vault/notas/nota.md': original,
    });

    await classifyApply(
      fs,
      '/vault',
      [{ path: 'notas/nota.md', temas: ['lms/cursos'] }],
      PROVENANCE_OPTS,
    );

    const meta = readNoteMetadata(await fs.readFile('/vault/notas/nota.md'), 'notas/nota.md');
    expect(meta.author).toBe('Otra Persona');
    expect(meta.estado).toBe('propuesto');
  });

  it('a human note (no source: chamba) only gets clasificado_por + agent, add-only — no author/written_at/estado', async () => {
    const original = `---\ntitle: Nota humana\nauthor: Autor Humano\ntags:\n  - chamba\n---\nEscrita a mano.\n`;
    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT,
      '/vault/notas/humana.md': original,
    });

    await classifyApply(
      fs,
      '/vault',
      [{ path: 'notas/humana.md', temas: ['lms/cursos'] }],
      PROVENANCE_OPTS,
    );

    const updated = await fs.readFile('/vault/notas/humana.md');
    const meta = readNoteMetadata(updated, 'notas/humana.md');
    expect(meta.clasificado_por).toBe('Joys');
    expect(meta.agent).toBe('chamba/classify@1.14.0');
    expect(meta.author).toBe('Autor Humano'); // untouched
    expect(meta.written_at).toBeUndefined();
    expect(meta.estado).toBeUndefined();
    expect(updated).toContain('Escrita a mano.');
  });

  it('a human note that already has clasificado_por/agent is not overwritten (add-only)', async () => {
    const original = `---\ntitle: Nota humana\nclasificado_por: Alguien Mas\nagent: chamba/classify@0.1.0\n---\nCuerpo.\n`;
    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT,
      '/vault/notas/humana.md': original,
    });

    await classifyApply(
      fs,
      '/vault',
      [{ path: 'notas/humana.md', temas: ['lms/cursos'] }],
      PROVENANCE_OPTS,
    );

    const meta = readNoteMetadata(await fs.readFile('/vault/notas/humana.md'), 'notas/humana.md');
    expect(meta.clasificado_por).toBe('Alguien Mas');
    expect(meta.agent).toBe('chamba/classify@0.1.0');
  });

  it('without provenanceOpts, no provenance keys are added at all (back-compat)', async () => {
    const original = `---\ntitle: Nota\n---\nCuerpo.\n`;
    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': VOCAB_CONTENT,
      '/vault/notas/nota.md': original,
    });
    await classifyApply(fs, '/vault', [{ path: 'notas/nota.md', temas: ['lms/cursos'] }]);
    const meta = readNoteMetadata(await fs.readFile('/vault/notas/nota.md'), 'notas/nota.md');
    expect(meta.agent).toBeUndefined();
    expect(meta.clasificado_por).toBeUndefined();
  });
});
