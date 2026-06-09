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
