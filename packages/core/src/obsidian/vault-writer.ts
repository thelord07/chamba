import type { ClockPort } from '../ports/clock.js';
import type { FilesystemPort } from '../ports/filesystem.js';
import { basename, joinPath } from '../util/path.js';
import { renderNote, slugify, slugifyGitRemote } from './note-template.js';
import { describeFromBody, INDEX_FILE, type IndexEntry, upsertIndexEntry } from './vault-index.js';

export interface WriteNoteInput {
  vaultPath: string;
  title: string;
  content: string;
  /** Filename slug; defaults to the title slug. */
  projectSlug?: string;
  tags?: string[];
  /** Vault subfolder to write into; defaults to `proyectos/`. */
  subdir?: string;
  /**
   * Git remote URL of the project. When set, notes are grouped under a stable
   * `<subdir>/<owner-repo>/` folder so every note for the same repo lands
   * together (dedup by project). Omit to keep the flat `<subdir>/` layout.
   */
  projectRemoteUrl?: string;
  /** One-line description for the folder index; defaults to the body's first line. */
  description?: string;
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
    const fileSlug = slugify(input.projectSlug ?? input.title);
    const projectKey = input.projectRemoteUrl
      ? slugifyGitRemote(input.projectRemoteUrl)
      : undefined;
    const baseDir = joinPath(input.vaultPath, input.subdir ?? VAULT_NOTES_DIR);
    const dir = projectKey ? joinPath(baseDir, projectKey) : baseDir;
    const fileName = `${date}-${fileSlug}.md`;
    const notePath = joinPath(dir, fileName);

    const note = renderNote({
      title: input.title,
      date,
      tags: input.tags && input.tags.length > 0 ? input.tags : ['chamba', 'project'],
      body: input.content,
    });

    await this.fs.mkdir(dir);
    await this.fs.writeFile(notePath, note);
    await this.updateIndex(dir, fileName, input);
    return { notePath };
  }

  /** Keep the folder's `INDEX.md` current so recall can scan it instead of every note. */
  private async updateIndex(dir: string, fileName: string, input: WriteNoteInput): Promise<void> {
    const indexPath = joinPath(dir, INDEX_FILE);
    let existing: string | null;
    try {
      existing = await this.fs.readFile(indexPath);
    } catch {
      existing = null;
    }
    const entry: IndexEntry = {
      title: input.title,
      path: fileName,
      description: input.description ?? describeFromBody(input.content),
    };
    const md = upsertIndexEntry(existing, basename(dir), entry);
    await this.fs.writeFile(indexPath, md);
  }
}
