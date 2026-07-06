/**
 * A lightweight, per-folder index note (`INDEX.md`) that lists the notes in its
 * folder as `{ title, path, description }`. Recall reads these cheap indexes
 * first and only opens full notes for the top candidates — Engram's index-first
 * idea, kept as plain, Obsidian-readable markdown. Pure: no fs, no clock, so it
 * round-trips deterministically (render → parse → render is stable).
 */

/** Filename of the per-folder index note. */
export const INDEX_FILE = 'INDEX.md';

const MAX_DESCRIPTION = 140;

export interface IndexEntry {
  /** Note title (display). */
  title: string;
  /** Path relative to the index note's own folder (usually just the filename). */
  path: string;
  /** One-line description used for cheap keyword matching. */
  description: string;
}

const ENTRY_RE = /^- \[(.+?)\]\(([^)]+)\)(?:\s+—\s+(.*))?$/;

/** Render a full index note for a folder. Deterministic — no dates, no churn. */
export function renderIndexNote(folderName: string, entries: IndexEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? 1 : a.path > b.path ? -1 : 0));
  const frontmatter = [
    '---',
    `title: "${folderName} index"`,
    'tags: [chamba, index]',
    'source: chamba',
    '---',
  ].join('\n');
  const header =
    `# ${folderName} index\n\n` +
    '> Maintained by chamba so recall can scan this list instead of reading every\n' +
    '> note. Safe to read; chamba may overwrite manual edits.';
  const lines = sorted.map(
    (e) => `- [${cleanTitle(e.title)}](${e.path})${e.description ? ` — ${e.description}` : ''}`,
  );
  const body = lines.length > 0 ? lines.join('\n') : '_(empty)_';
  return `${frontmatter}\n\n${header}\n\n${body}\n`;
}

/** Parse an index note back into its entries. Ignores non-entry lines. */
export function parseIndexNote(markdown: string): IndexEntry[] {
  const out: IndexEntry[] = [];
  for (const raw of markdown.split('\n')) {
    const m = ENTRY_RE.exec(raw.trim());
    if (!m) continue;
    const [, title, path, description] = m;
    if (title === undefined || path === undefined) continue;
    out.push({ title, path, description: (description ?? '').trim() });
  }
  return out;
}

/**
 * Upsert one entry into an existing index (or a fresh one), keyed by `path`.
 * Returns the new index markdown.
 */
export function upsertIndexEntry(
  existing: string | null,
  folderName: string,
  entry: IndexEntry,
): string {
  const entries = existing ? parseIndexNote(existing) : [];
  const next = entries.filter((e) => e.path !== entry.path);
  next.push({ ...entry, description: clampDescription(entry.description) });
  return renderIndexNote(folderName, next);
}

/** Derive a one-line description from a note body: first meaningful, non-heading line. */
export function describeFromBody(body: string): string {
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#') || line.startsWith('---') || line.startsWith('>')) continue;
    return clampDescription(line);
  }
  return '';
}

function clampDescription(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_DESCRIPTION ? `${oneLine.slice(0, MAX_DESCRIPTION - 1)}…` : oneLine;
}

function cleanTitle(title: string): string {
  return (
    title
      .replace(/[[\]()]/g, '')
      .replace(/\s+/g, ' ')
      .trim() || 'note'
  );
}
