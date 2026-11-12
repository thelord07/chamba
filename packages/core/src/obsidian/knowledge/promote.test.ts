import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../../testing/memory-filesystem.js';
import { readNoteMetadata } from './note-metadata.js';
import { promoteNotesApply, promoteNotesPlan } from './promote.js';

describe('promoteNotesPlan / promoteNotesApply', () => {
  it('promotes a single propuesto note to canonico', async () => {
    const content = '---\ntitle: Nota\nestado: propuesto\n---\nCuerpo.\n';
    const fs = new MemoryFilesystem({ '/vault/notas/a.md': content });

    const plan = await promoteNotesPlan(fs, '/vault', ['notas/a.md']);
    expect(plan.diffs).toHaveLength(1);
    expect(plan.rejected).toHaveLength(0);

    const applied = await promoteNotesApply(fs, '/vault', ['notas/a.md']);
    expect(applied.written).toEqual(['notas/a.md']);

    const meta = readNoteMetadata(await fs.readFile('/vault/notas/a.md'), 'notas/a.md');
    expect(meta.estado).toBe('canonico');
  });

  it('promoting clears flag: revisar', async () => {
    const content = '---\ntitle: Nota\nestado: propuesto\nflag: revisar\n---\nCuerpo.\n';
    const fs = new MemoryFilesystem({ '/vault/notas/a.md': content });
    await promoteNotesApply(fs, '/vault', ['notas/a.md']);
    const updated = await fs.readFile('/vault/notas/a.md');
    expect(updated).not.toContain('flag:');
    const meta = readNoteMetadata(updated, 'notas/a.md');
    expect(meta.estado).toBe('canonico');
    expect(meta.flag).toBeUndefined();
  });

  it('bulk apply with dryRun default (promoteNotesPlan) writes nothing', async () => {
    const files: Record<string, string> = {};
    for (const n of ['a', 'b', 'c']) {
      files[`/vault/notas/${n}.md`] = `---\ntitle: ${n}\nestado: propuesto\n---\nCuerpo.\n`;
    }
    const fs = new MemoryFilesystem(files);
    const plan = await promoteNotesPlan(fs, '/vault', ['notas/a.md', 'notas/b.md', 'notas/c.md']);
    expect(plan.diffs).toHaveLength(3);
    for (const n of ['a', 'b', 'c']) {
      const content = await fs.readFile(`/vault/notas/${n}.md`);
      expect(content).toContain('estado: propuesto'); // unchanged
    }
  });

  it('bulk apply with dryRun:false writes all', async () => {
    const files: Record<string, string> = {};
    for (const n of ['a', 'b', 'c']) {
      files[`/vault/notas/${n}.md`] = `---\ntitle: ${n}\nestado: propuesto\n---\nCuerpo.\n`;
    }
    const fs = new MemoryFilesystem(files);
    const applied = await promoteNotesApply(fs, '/vault', [
      'notas/a.md',
      'notas/b.md',
      'notas/c.md',
    ]);
    expect(applied.written).toHaveLength(3);
    for (const n of ['a', 'b', 'c']) {
      const meta = readNoteMetadata(await fs.readFile(`/vault/notas/${n}.md`), `notas/${n}.md`);
      expect(meta.estado).toBe('canonico');
    }
  });

  it('rejects a path outside the vault', async () => {
    const fs = new MemoryFilesystem({});
    const plan = await promoteNotesPlan(fs, '/vault', ['../outside.md']);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.diffs).toHaveLength(0);
  });

  it('rejects a derived (chamba-generated index) path', async () => {
    const fs = new MemoryFilesystem({ '/vault/INDEX.md': '# Generado\n' });
    const plan = await promoteNotesPlan(fs, '/vault', ['INDEX.md']);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.reason).toMatch(/derivado/);
  });

  it('an already-canonico note is reported as a no-op, not an error', async () => {
    const fs = new MemoryFilesystem({
      '/vault/notas/a.md': '---\ntitle: Nota\nestado: canonico\n---\nCuerpo.\n',
    });
    const plan = await promoteNotesPlan(fs, '/vault', ['notas/a.md']);
    expect(plan.diffs).toHaveLength(0);
    expect(plan.rejected).toHaveLength(1);
    expect(plan.rejected[0]?.reason).toMatch(/no-op/);
  });

  it('a note with no estado (D-Q3: absent ⇒ canonico) is also a no-op', async () => {
    const fs = new MemoryFilesystem({
      '/vault/notas/a.md': '---\ntitle: Nota\n---\nCuerpo.\n',
    });
    const plan = await promoteNotesPlan(fs, '/vault', ['notas/a.md']);
    expect(plan.rejected).toHaveLength(1);
  });

  it('a non-existent note is rejected with a clear reason', async () => {
    const fs = new MemoryFilesystem({});
    const plan = await promoteNotesPlan(fs, '/vault', ['notas/missing.md']);
    expect(plan.rejected[0]?.reason).toMatch(/no encontrado/);
  });
});
