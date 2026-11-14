/**
 * reindexer.test.ts — CHAMBA-022 (B8)
 *
 * `VAULT_SKIP_DIRS` only matches the TOP-LEVEL path segment, so it can never
 * skip `tareas/<id>/evidencia/` (a nested prefix). `isTaskEvidencePath`
 * fixes that in every walker, including the reindexer's. These tests prove
 * a vault full of evidence files never pollutes the reindex — note counts
 * stay unchanged, and a legitimate note under `tareas/` IS still indexed.
 */
import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../../testing/memory-filesystem.js';
import { VaultReindexer } from './reindexer.js';

const VAULT = '/vault';

async function seedEvidenceRun(
  fs: MemoryFilesystem,
  workItem: string,
  runId: string,
  fileCount: number,
): Promise<void> {
  const dir = `${VAULT}/tareas/${workItem}/evidencia/${runId}`;
  await fs.mkdir(dir);
  for (let i = 0; i < fileCount; i++) {
    await fs.writeFile(`${dir}/tests-${i}.md`, `# evidencia ${i}\n\nexit 0\n`);
  }
}

describe('VaultReindexer — B8: isTaskEvidencePath aplicado en los walkers', () => {
  it('3 runs × 200 archivos bajo tareas/<id>/evidencia/ no cambian el conteo de notas', async () => {
    const fs = new MemoryFilesystem();
    await fs.mkdir(VAULT);

    // Baseline: one unrelated real note.
    await fs.writeFile(`${VAULT}/proyectos/una-nota.md`, '---\ntitle: nota\ntype: nota\n---\n# x');

    const reindexer = new VaultReindexer(fs, VAULT);
    const before = await reindexer.reindex({ dryRun: true });

    for (const runId of ['run-20261113-01', 'run-20261113-02', 'run-20261113-03']) {
      await seedEvidenceRun(fs, 'chamba-022', runId, 200);
    }

    const after = await reindexer.reindex({ dryRun: true });
    expect(after.notas).toBe(before.notas);
  });

  it('una nota legítima en tareas/<id>.md SÍ se indexa (solo evidencia/ se excluye)', async () => {
    const fs = new MemoryFilesystem();
    await fs.mkdir(VAULT);
    await fs.writeFile(
      `${VAULT}/tareas/chamba-022.md`,
      '---\ntitle: CHAMBA-022\ntype: tarea\nwork_item: CHAMBA-022\n---\n# CHAMBA-022',
    );
    await seedEvidenceRun(fs, 'chamba-022', 'run-20261113-01', 50);

    const reindexer = new VaultReindexer(fs, VAULT);
    const report = await reindexer.reindex({ dryRun: true });
    expect(report.notas).toBe(1);
  });

  it('un archivo con nombre que empieza con "evidencia" pero no es el subárbol SÍ se indexa', async () => {
    const fs = new MemoryFilesystem();
    await fs.mkdir(VAULT);
    await fs.writeFile(`${VAULT}/tareas/chamba-022/evidenciario.md`, '---\ntype: nota\n---\n# x');

    const reindexer = new VaultReindexer(fs, VAULT);
    const report = await reindexer.reindex({ dryRun: true });
    expect(report.notas).toBe(1);
  });
});
