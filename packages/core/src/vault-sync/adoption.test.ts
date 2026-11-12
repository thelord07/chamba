/**
 * adoption.test.ts — Tests for buildAdoptionSummary.
 * PARCHE-009 AC4,5 (support).
 */

import { describe, expect, it } from 'vitest';
import { addSecretAllowEntry } from '../secrets/allowlist.js';
import { FakeHash } from '../testing/fake-hash.js';
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

  // ── CHAMBA-021 S7 ──────────────────────────────────────────────────────────

  it('without deps.hash, blocked is always [] (backward compatibility)', async () => {
    const fs = new MemoryFilesystem({
      [`${VAULT}/secret.md`]: `token: ${'pch_'}${'A'.repeat(24)}\n`,
    });
    const summary = await buildAdoptionSummary({ fs }, VAULT);
    expect(summary.blocked).toEqual([]);
    expect(summary.blockedCount).toBe(0);
  });

  it('with deps.hash, a file with a secret is reported in blocked (same walk)', async () => {
    const fs = new MemoryFilesystem({
      [`${VAULT}/clean.md`]: '# fine\n',
      [`${VAULT}/secret.md`]: `token: ${'pch_'}${'A'.repeat(24)}\n`,
    });
    const summary = await buildAdoptionSummary({ fs, hash: new FakeHash() }, VAULT);
    expect(summary.syncableCount).toBe(2); // the count is unaffected
    expect(summary.blockedCount).toBe(1);
    expect(summary.blocked[0]?.path).toBe('secret.md');
  });

  it('CHAMBA-023 D-Q3: a real (binary) image never appears in blocked', async () => {
    const fs = new MemoryFilesystem();
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
      0x52, 0xff, 0xfe, 0xfd, 0xfc,
    ]);
    await fs.writeBytes(`${VAULT}/diagram.png`, png);
    const summary = await buildAdoptionSummary({ fs, hash: new FakeHash() }, VAULT);
    expect(summary.blocked).toEqual([]);
  });

  it('CHAMBA-023 D-Q3: a .png/.pdf WITH a secret-shaped body that decodes as UTF-8 IS scanned (content, not extension)', async () => {
    const fs = new MemoryFilesystem({
      [`${VAULT}/looks-like-a-secret.png`]: `token: ${'pch_'}${'A'.repeat(24)}\n`,
      [`${VAULT}/looks-like-a-secret.pdf`]: `token: ${'pch_'}${'A'.repeat(24)}\n`,
    });
    const summary = await buildAdoptionSummary({ fs, hash: new FakeHash() }, VAULT);
    expect(summary.blocked.map((f) => f.path).sort()).toEqual([
      'looks-like-a-secret.pdf',
      'looks-like-a-secret.png',
    ]);
  });

  it('excludes a finding already marked as a false positive in the local allowlist', async () => {
    const fs = new MemoryFilesystem({
      [`${VAULT}/secret.md`]: `token: ${'pch_'}${'A'.repeat(24)}\n`,
    });
    const hash = new FakeHash();
    const first = await buildAdoptionSummary({ fs, hash }, VAULT);
    expect(first.blockedCount).toBe(1);

    const clock = {
      now: () => new Date('2026-10-29T12:00:00Z'),
      today: () => '2026-10-29',
      sleep: () => Promise.resolve(),
    };
    await addSecretAllowEntry(fs, clock, VAULT, {
      path: 'secret.md',
      fingerprint: first.blocked[0]?.fingerprint ?? '',
    });

    const after = await buildAdoptionSummary({ fs, hash }, VAULT);
    expect(after.blockedCount).toBe(0);
    expect(after.blocked).toEqual([]);
    // Allowlisting never affects the syncable count/sample.
    expect(after.syncableCount).toBe(1);
  });
});
