export interface NoteFields {
  title: string;
  /** `YYYY-MM-DD`. */
  date: string;
  tags: string[];
  /** Markdown body the model produced (summary, plan, decisions, etc.). */
  body: string;
}

/** Turn a title into a filesystem- and Obsidian-friendly slug. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'note';
}

/**
 * Normalize a git remote URL into a stable `owner-repo` slug, so every note
 * written for the same repository lands under the same project key regardless
 * of how the URL was spelled (ssh vs https, with or without `.git`). Mirrors
 * Engram's project-name normalization; used to group vault notes by project.
 *
 * `git@github.com:acme/app.git` → `acme-app`
 * `https://github.com/acme/app`  → `acme-app`
 */
export function slugifyGitRemote(url: string): string {
  const path = url
    .trim()
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '')
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '') // scheme://
    .replace(/^[^@/]+@/, '') // user@
    .replace(':', '/'); // scp-style host:owner → host/owner
  const parts = path.split('/').filter((p) => p.length > 0);
  const tail = parts.slice(-2); // owner + repo (or just repo)
  return slugify(tail.join('-'));
}

/**
 * Render a vault note: valid YAML frontmatter (parseable by Obsidian) followed
 * by the model's markdown body. Override this template by passing your own body
 * structure — chamba only owns the frontmatter and the title heading.
 */
export function renderNote(fields: NoteFields): string {
  const tags = fields.tags.map((t) => slugify(t)).filter((t) => t.length > 0);
  const frontmatter = [
    '---',
    `title: "${escapeYaml(fields.title)}"`,
    `date: ${fields.date}`,
    `tags: [${tags.join(', ')}]`,
    'source: chamba',
    '---',
  ].join('\n');

  return `${frontmatter}\n\n# ${fields.title}\n\n${fields.body.trim()}\n`;
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
