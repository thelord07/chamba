import type { ClockPort } from '../ports/clock.js';
import type { FilesystemPort } from '../ports/filesystem.js';
import { joinPath } from '../util/path.js';
import { renderNote, slugify } from './note-template.js';

export interface WriteNoteInput {
  vaultPath: string;
  title: string;
  content: string;
  /** Filename slug; defaults to the title slug. */
  projectSlug?: string;
  tags?: string[];
  /** Vault subfolder to write into; defaults to `proyectos/`. */
  subdir?: string;
}

export interface WriteNoteResult {
  notePath: string;
}

/** Subfolder inside the vault where chamba writes its run summaries. */
export const VAULT_NOTES_DIR = 'proyectos';

/** Subfolder inside the vault where chamba saves plans. */
export const VAULT_PLANS_DIR = 'plans';

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
    const dir = joinPath(input.vaultPath, input.subdir ?? VAULT_NOTES_DIR);
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
