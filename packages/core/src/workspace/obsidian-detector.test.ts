import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { ObsidianDetector } from './obsidian-detector.js';

const vaultFiles = {
  '/vault/.obsidian/app.json': '{}',
  '/vault/auth.md': '# Auth\n',
  '/vault/sub/note.md': '# Note\n',
};

describe('ObsidianDetector', () => {
  it('honours an explicit vault path and counts notes', async () => {
    const detector = new ObsidianDetector(new MemoryFilesystem(vaultFiles));
    const result = await detector.detect({ explicitPath: '/vault' });

    expect(result.found).toBe(true);
    expect(result.path).toBe('/vault');
    expect(result.noteCount).toBe(2); // .obsidian is skipped
  });

  it('returns not found for an explicit path that does not exist', async () => {
    const detector = new ObsidianDetector(new MemoryFilesystem(vaultFiles));
    expect(await detector.detect({ explicitPath: '/nope' })).toEqual({ found: false });
  });

  it('auto-detects via a .obsidian marker in a search root', async () => {
    const detector = new ObsidianDetector(new MemoryFilesystem(vaultFiles));
    const result = await detector.detect({ searchRoots: ['/home/Documents', '/vault'] });

    expect(result.found).toBe(true);
    expect(result.path).toBe('/vault');
  });

  it('returns not found when no search root has a vault', async () => {
    const detector = new ObsidianDetector(new MemoryFilesystem(vaultFiles));
    expect(await detector.detect({ searchRoots: ['/home/Documents', '/home/Notes'] })).toEqual({
      found: false,
    });
  });
});
