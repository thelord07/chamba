import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import {
  collectDesignRefs,
  loadDesignConventions,
  parseDesignFrontmatter,
  rankDesigns,
  readDesign,
  saveDesignConventions,
} from './design-registry.js';

const POINTER = `---
name: checkout-redesign
description: New checkout flow — 3 screens
figma: https://figma.com/file/abc
folder: ~/Designs/checkout
prototype: ~/Designs/checkout/app.html
---
Build to atoms/molecules. States: default, loading, error.
`;

describe('parseDesignFrontmatter', () => {
  it('parses name, description and the source links', () => {
    const ref = parseDesignFrontmatter(POINTER, '/ws/.chamba/design/checkout.md');
    expect(ref?.name).toBe('checkout-redesign');
    expect(ref?.figma).toBe('https://figma.com/file/abc');
    expect(ref?.folder).toBe('~/Designs/checkout');
    expect(ref?.prototype).toBe('~/Designs/checkout/app.html');
  });

  it('returns null without a name', () => {
    expect(parseDesignFrontmatter('---\ndescription: x\n---\nbody', '/p.md')).toBeNull();
  });
});

describe('collectDesignRefs', () => {
  it('collects pointers, ignores README, dedups by name (first dir wins)', async () => {
    const fs = new MemoryFilesystem({
      '/ws/.chamba/design/checkout.md': POINTER,
      '/ws/.chamba/design/README.md': '# not a source',
      '/ws/.chamba/design/login.md': '---\nname: login\ndescription: Login screen\n---\nbrief',
      '/home/.chamba/design/checkout.md': '---\nname: checkout-redesign\ndescription: dup\n---\n',
    });
    const refs = await collectDesignRefs(fs, ['/ws/.chamba/design', '/home/.chamba/design']);
    expect(refs.map((r) => r.name).sort()).toEqual(['checkout-redesign', 'login']);
    // project entry wins over the global dup
    expect(refs.find((r) => r.name === 'checkout-redesign')?.description).toBe(
      'New checkout flow — 3 screens',
    );
  });
});

describe('rankDesigns', () => {
  it('ranks by task relevance and filters non-matches', async () => {
    const refs = [
      { name: 'checkout-redesign', description: 'checkout flow screens', path: 'a.md' },
      { name: 'login', description: 'login screen', path: 'b.md' },
    ];
    const ranked = rankDesigns('rework the checkout flow', refs, 3);
    expect(ranked[0]?.name).toBe('checkout-redesign');
    expect(ranked.map((r) => r.name)).not.toContain('login');
  });
});

describe('readDesign', () => {
  it('reads the brief and categorizes assets, expanding ~', async () => {
    const fs = new MemoryFilesystem({
      '/ws/.chamba/design/checkout.md': POINTER,
      '/home/Designs/checkout/screen-1.png': 'binary',
      '/home/Designs/checkout/spec.md': '# Spec\nUse a 12-col grid.',
      '/home/Designs/checkout/app.html': '<html>proto</html>',
      '/home/Designs/checkout/notes.psd': 'other',
    });
    const ref = parseDesignFrontmatter(POINTER, '/ws/.chamba/design/checkout.md');
    if (!ref) throw new Error('ref');
    const design = await readDesign(fs, ref, '/home');
    if (!design) throw new Error('design');

    expect(design.brief).toContain('atoms/molecules');
    const byKind = (k: string) => design.assets.filter((a) => a.kind === k).map((a) => a.name);
    expect(byKind('image')).toContain('screen-1.png');
    expect(byKind('prototype')).toContain('app.html');
    expect(byKind('other')).toContain('notes.psd');
    const spec = design.assets.find((a) => a.name === 'spec.md');
    expect(spec?.kind).toBe('spec');
    expect(spec?.excerpt).toContain('12-col grid');
  });

  it('tolerates a missing folder', async () => {
    const fs = new MemoryFilesystem({
      '/ws/.chamba/design/x.md': '---\nname: x\ndescription: d\nfolder: ~/gone\n---\nbrief',
    });
    const ref = parseDesignFrontmatter(
      '---\nname: x\ndescription: d\nfolder: ~/gone\n---\nbrief',
      '/ws/.chamba/design/x.md',
    );
    if (!ref) throw new Error('ref');
    const design = await readDesign(fs, ref, '/home');
    expect(design?.assets).toEqual([]);
  });
});

describe('design conventions', () => {
  it('saves, merges and loads the architecture preference (project wins)', async () => {
    const fs = new MemoryFilesystem({
      '/home/.chamba/design/conventions.json': JSON.stringify({
        web: 'by-route',
        mobile: 'atomic',
      }),
    });

    const saved = await saveDesignConventions(fs, '/ws/.chamba/design', { web: 'atomic' });
    expect(saved.web).toBe('atomic');
    // a second patch merges without clobbering the other field
    const saved2 = await saveDesignConventions(fs, '/ws/.chamba/design', { mobile: 'screens' });
    expect(saved2).toEqual({ web: 'atomic', mobile: 'screens' });

    const conv = await loadDesignConventions(fs, ['/ws/.chamba/design', '/home/.chamba/design']);
    expect(conv.web).toBe('atomic'); // project overrides global 'by-route'
    expect(conv.mobile).toBe('screens');
  });

  it('returns empty when no conventions file exists', async () => {
    const fs = new MemoryFilesystem({});
    expect(await loadDesignConventions(fs, ['/ws/.chamba/design'])).toEqual({});
  });
});
