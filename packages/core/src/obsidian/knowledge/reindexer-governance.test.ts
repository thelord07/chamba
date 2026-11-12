/**
 * reindexer-governance.test.ts — CHAMBA-021 S13 compatibility guard.
 *
 * D-Q3 (owner decision): `estado` absent ⇒ canónico, for ANY note. This test
 * fixes that a vault with no `estado` keys at all (the state of every team
 * vault before this feature) reindexes with ZERO content churn — no note
 * gets the `· propuesto` marker, so no hub/INDEX/sin-clasificar file changes
 * bytes on the first reindex after the upgrade.
 */
import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../../testing/memory-filesystem.js';
import { VaultReindexer } from './reindexer.js';

const VOCAB = `---
title: "Vocabulario de temas"
source: human
umbral_promover: 3
umbral_dividir: 25
generar_bases: true
---
# Vocabulario de temas

- \`lms\` — LMS.
  - \`lms/cursos\` — Gestión de cursos.
`;

describe('CHAMBA-021 S13: reindex over a vault without estado writes no content changes', () => {
  it('a second reindex (no source changes) writes nothing', async () => {
    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': VOCAB,
      '/vault/notas/a.md': '---\ntitle: Nota A\ntags:\n  - tema/lms/cursos\n---\nCuerpo A.\n',
      '/vault/notas/b.md': '---\ntitle: Nota B\ntags:\n  - tema/lms/cursos\n---\nCuerpo B.\n',
    });

    const reindexer = new VaultReindexer(fs, '/vault');
    const first = await reindexer.reindex();
    expect(first.archivosEscritos.length).toBeGreaterThan(0);

    const second = await reindexer.reindex();
    expect(second.archivosEscritos).toEqual([]);
  });

  it('none of the generated hub/INDEX/sin-clasificar lines carry a propuesto marker', async () => {
    const fs = new MemoryFilesystem({
      '/vault/temas/VOCABULARIO.md': VOCAB,
      '/vault/notas/a.md': '---\ntitle: Nota A\ntags:\n  - tema/lms/cursos\n---\nCuerpo A.\n',
    });
    const reindexer = new VaultReindexer(fs, '/vault');
    await reindexer.reindex();

    const hub = await fs.readFile('/vault/temas/lms/cursos.md');
    expect(hub).not.toContain('propuesto');
    const index = await fs.readFile('/vault/INDEX.md');
    expect(index).not.toContain('propuesto');
  });
});
