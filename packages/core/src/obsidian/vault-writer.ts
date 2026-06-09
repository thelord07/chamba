import type { ClockPort } from '../ports/clock.js';
import type { FilesystemPort } from '../ports/filesystem.js';
import { joinPath } from '../util/path.js';
import { renderNote, slugify } from './note-template.js';

export interface WriteNoteInput {
  vaultPath: string;
  title: string;
  content: string;
  /** Subfolder slug under `proyectos/`; defaults to the title slug. */
  projectSlug?: string;
  tags?: string[];
}

export interface WriteNoteResult {
  notePath: string;
}

/** Subfolder inside the vault where chamba writes its summaries. */
export const VAULT_NOTES_DIR = 'proyectos';

/**
 * Write a structured summary note into an Obsidian vault at
 * `<vault>/proyectos/<date>-<slug>.md` with valid YAML frontmatter.
 */
export class VaultWriter {
  constructor(
    private readonly fs: FilesystemPort,
    private readonly clock: ClockPort,
  ) {}

  async write(input: WriteNoteInput): Promise<WriteNoteResult> {
    const date = this.clock.today();
    const slug = slugify(input.projectSlug ?? input.title);
    const dir = joinPath(input.vaultPath, VAULT_NOTES_DIR);
    const notePath = joinPath(dir, `${date}-${slug}.md`);

    const note = renderNote({
      title: input.title,
      date,
      tags: input.tags && input.tags.length > 0 ? input.tags : ['chamba', 'project'],
      body: input.content,
    });

    await this.fs.mkdir(dir);
    await this.fs.writeFile(notePath, note);
    return { notePath };
  }
}
