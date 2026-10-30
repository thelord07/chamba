/**
 * adoption.test.ts — Tests for buildAdoptionSummary.
 * PARCHE-009 AC4,5 (support).
 */

import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { buildAdoptionSummary } from './adoption.js';

const VAULT = '/vault';

describe('buildAdoptionSummary', () => {
  it('returns zero counts for an empty vault', async () => {
    const fs = new MemoryFilesystem();
    await fs.mkdir(VAULT);
    const summary = await buildAdoptionSummary({ fs }, VAULT);
    expect(summary.syncableCount).toBe(0);
    expect(summary.ignoredCount).toBe(0);
    expect(summary.sample).toEqual([]);
  });

  it('counts syncable .md files (AC4)', async () => {
    const fs = new MemoryFilesystem({
      [`${VAULT}/note1.md`]: '# Note 1',
      [`${VAULT}/note2.md`]: '# Note 2',
      [`${VAULT}/.obsidian/workspace`]: '{}',
    });
    const summary = await buildAdoptionSummary({ fs }, VAULT);
    expect(summary.syncableCount).toBe(2);
    expect(summary.ignoredCount).toBe(1); // .obsidian/workspace is not syncable
    expect(summary.sample).toHaveLength(2);
  });

  it('counts ignored files (.obsidian, .chamba-sync, no-ext) (AC4)', async () => {
    const fs = new MemoryFilesystem({
      [`${VAULT}/note.md`]: '# Note',
      [`${VAULT}/.obsidian/plugins/config.json`]: '{}',
      [`${VAULT}/.chamba-sync/state.json`]: '{}',
      [`${VAULT}/noext`]: 'data',
      [`${VAULT}/image.png`]: 'img',
    });
    const summary = await buildAdoptionSummary({ fs }, VAULT);
    // syncable: note.md, image.png
    expect(summary.syncableCount).toBe(2);
    // ignored: .obsidian/..., .chamba-sync/..., noext
    expect(summary.ignoredCount).toBe(3);
  });

  it('sample contains at most 20 paths (AC4)', async () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 30; i++) {
      files[`${VAULT}/note-${String(i).padStart(2, '0')}.md`] = `# Note ${i}`;
    }
    const fs = new MemoryFilesystem(files);
    const summary = await buildAdoptionSummary({ fs }, VAULT);
    expect(summary.syncableCount).toBe(30);
    expect(summary.sample).toHaveLength(20);
  });

  it('sample is sorted in stable order (AC4)', async () => {
    const fs = new MemoryFilesystem({
      [`${VAULT}/c.md`]: 'C',
      [`${VAULT}/a.md`]: 'A',
      [`${VAULT}/b.md`]: 'B',
    });
    const summary = await buildAdoptionSummary({ fs }, VAULT);
    expect(summary.sample).toEqual(['a.md', 'b.md', 'c.md']);
  });

  it('handles nested directories correctly', async () => {
    const fs = new MemoryFilesystem({
      [`${VAULT}/folder/deep/note.md`]: '# Deep',
      [`${VAULT}/top.md`]: '# Top',
      [`${VAULT}/.obsidian/cache`]: 'cache',
    });
    const summary = await buildAdoptionSummary({ fs }, VAULT);
    expect(summary.syncableCount).toBe(2);
    expect(summary.sample).toContain('folder/deep/note.md');
    expect(summary.sample).toContain('top.md');
  });
});
