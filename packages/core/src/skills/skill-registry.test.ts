import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import {
  collectSkillRefs,
  parseSkillFrontmatter,
  rankSkills,
  readSkill,
} from './skill-registry.js';

const knex = `---
name: knex-multitenant
description: Multi-tenant Knex queries — always filter by tenant_id
scope: backend
---
Always scope every query by tenant_id. Never trust a client-provided tenant.
`;

const react = `---
name: react-hooks
description: Custom React hooks conventions for the dashboard
---
Prefix hooks with use, keep them pure, no side effects in render.
`;

describe('parseSkillFrontmatter', () => {
  it('parses name, description and scope', () => {
    const ref = parseSkillFrontmatter(knex, '/s/knex.md');
    expect(ref).toEqual({
      name: 'knex-multitenant',
      description: 'Multi-tenant Knex queries — always filter by tenant_id',
      scope: 'backend',
      path: '/s/knex.md',
    });
  });

  it('returns null without frontmatter or without a name', () => {
    expect(parseSkillFrontmatter('# just a note\n', '/s/n.md')).toBeNull();
    expect(parseSkillFrontmatter('---\ndescription: no name\n---\nbody', '/s/n.md')).toBeNull();
  });
});

describe('collectSkillRefs', () => {
  it('scans *.md, ignoring README and files without frontmatter', () => {
    const fs = new MemoryFilesystem({
      '/proj/.chamba/skills/knex.md': knex,
      '/proj/.chamba/skills/react.md': react,
      '/proj/.chamba/skills/README.md': '# how to write skills',
      '/proj/.chamba/skills/notes.md': 'plain note, no frontmatter',
    });
    return collectSkillRefs(fs, ['/proj/.chamba/skills']).then((refs) => {
      expect(refs.map((r) => r.name).sort()).toEqual(['knex-multitenant', 'react-hooks']);
    });
  });

  it('dedups by name, first directory wins (project over global)', async () => {
    const fs = new MemoryFilesystem({
      '/proj/.chamba/skills/knex.md': knex,
      '/home/.chamba/skills/knex.md': `---\nname: knex-multitenant\ndescription: personal older version\n---\nold`,
    });
    const refs = await collectSkillRefs(fs, ['/proj/.chamba/skills', '/home/.chamba/skills']);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.description).toContain('always filter by tenant_id');
  });

  it('returns nothing for a missing directory', async () => {
    const fs = new MemoryFilesystem({});
    expect(await collectSkillRefs(fs, ['/nope/skills'])).toEqual([]);
  });
});

describe('rankSkills', () => {
  const refs = [
    {
      name: 'knex-multitenant',
      description: 'Multi-tenant Knex queries filter by tenant_id',
      scope: 'backend',
      path: '/s/knex.md',
    },
    { name: 'react-hooks', description: 'Custom React hooks conventions', path: '/s/react.md' },
  ];

  it('ranks by relevance and drops non-matches', () => {
    const ranked = rankSkills('add a multi-tenant knex query for invoices', refs);
    expect(ranked.map((r) => r.name)).toEqual(['knex-multitenant']);
  });

  it('returns nothing when nothing matches', () => {
    expect(rankSkills('update the CI pipeline yaml', refs)).toEqual([]);
  });

  it('respects the max', () => {
    const many = [refs[0], refs[1], { ...refs[0], name: 'knex-2', path: '/s/k2.md' }].filter(
      (r): r is (typeof refs)[number] => Boolean(r),
    );
    expect(rankSkills('react hooks and knex tenant', many, 1)).toHaveLength(1);
  });
});

describe('readSkill', () => {
  it('returns the ref plus the trimmed body', async () => {
    const fs = new MemoryFilesystem({ '/s/knex.md': knex });
    const skill = await readSkill(fs, '/s/knex.md');
    expect(skill?.name).toBe('knex-multitenant');
    expect(skill?.body).toBe(
      'Always scope every query by tenant_id. Never trust a client-provided tenant.',
    );
  });

  it('returns null for a file without frontmatter', async () => {
    const fs = new MemoryFilesystem({ '/s/n.md': 'no frontmatter' });
    expect(await readSkill(fs, '/s/n.md')).toBeNull();
  });
});
