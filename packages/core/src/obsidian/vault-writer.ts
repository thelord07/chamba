import type { ClockPort } from '../ports/clock.js';
import type { FilesystemPort } from '../ports/filesystem.js';
import { joinPath } from '../util/path.js';
import type { TopicSuggestion } from './knowledge/knowledge-graph.js';
import type { NoteType } from './knowledge/note-metadata.js';
import { readNoteMetadata, upsertNoteMetadata } from './knowledge/note-metadata.js';
import type { Provenance } from './knowledge/provenance.js';
import type { ReindexReport } from './knowledge/reindexer.js';
import { VaultReindexer } from './knowledge/reindexer.js';
import type { ClosestTopicResult } from './knowledge/topics.js';
import { closestTopics, compactTopicTree } from './knowledge/topics.js';
import { parseVocabulary, resolveTopic } from './knowledge/vocabulary.js';
import { slugify, slugifyGitRemote } from './note-template.js';

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
  /** Legacy one-line description; used as `summary` when `summary` is not given. */
  description?: string;

  // ── New fields (CHAMBA-016) ────────────────────────────────────────────────
  /** 1-line summary ≤ 200 chars. */
  summary?: string;
  /**
   * Topic paths or aliases from the vocabulary (1..5).
   * Valid paths → `tags: tema/<path>`.
   * Unknown → `temas_propuestos` + suggestions.
   */
  temas?: string[];
  /** 0..10 keywords, ≤ 40 chars each. */
  keywords?: string[];
  /** Obsidian aliases (native). */
  aliases?: string[];
  /** Work item ID (hu-..., cu-..., etc.) linking plan ↔ summary. */
  workItem?: string;
  /** Explicit related note paths (vault-relative). */
  related?: string[];
  /** Note type; save_plan fixes this to 'plan'. */
  type?: NoteType;
  /** Project slug (slugifyGitRemote). */
  project?: string;

  // ── CHAMBA-021 S11: provenance ──────────────────────────────────────────────
  /**
   * Provenance of this write (author/agent/written_at). When present, the note
   * gets `estado: propuesto` — every note VaultWriter writes is `source: chamba`,
   * so there is no human-owned target to protect here (add-only lives in
   * FilesystemMemoryStore and classifyApply, where a human-authored file can
   * genuinely sit at the write target).
   */
  provenance?: Provenance;
  /** S5/S11: set `flag: 'revisar'` when `detectInstructionLike` found a match. */
  flagRevisar?: boolean;
}

export interface WriteNoteResult {
  notePath: string;

  // ── Extended response (CHAMBA-016) ─────────────────────────────────────────
  warnings: string[];
  temasAplicados: string[];
  temasPropuestos: string[];
  sugerencias: TopicSuggestion[];
  /** Compact topic tree (≤ 60 lines). */
  arbol: string;
  /** 5 closest vocabulary nodes to title+summary+keywords. */
  cercanos: ClosestTopicResult[];
  /** Vault-relative paths of related notes (from workItem linking). */
  related: string[];
  reindex: ReindexReport;
}

/** Subfolder inside the vault where chamba writes its run summaries. */
export const VAULT_NOTES_DIR = 'proyectos';

/** Subfolder inside the vault where chamba saves plans. */
export const VAULT_PLANS_DIR = 'plans';

const VOCAB_REL_PATH = 'temas/VOCABULARIO.md';

/**
 * Write a structured summary note into an Obsidian vault at
 * `<vault>/<subdir>/<date>-<slug>.md` with valid YAML frontmatter.
 *
 * When `temas` / `summary` are provided, validates against the vocabulary
 * (if present), builds tags, and triggers reindex.
 *
 * Backward-compatible: callers that do not pass `temas`/`summary` still work
 * exactly as before (note is written, reindex runs silently).
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

    // ── Load vocabulary (optional) ──────────────────────────────────────────
    const vocabulary = await this.loadVocabulary(input.vaultPath);

    // ── Resolve temas ────────────────────────────────────────────────────────
    const warnings: string[] = [];
    const temasAplicados: string[] = [];
    const temasPropuestos: string[] = [];
    const sugerencias: TopicSuggestion[] = [];

    if (input.temas && input.temas.length > 0) {
      if (vocabulary === null) {
        // No vocabulary — all temas go to temas_propuestos
        temasPropuestos.push(...input.temas.map((t) => t.replace(/^tema\//, '')));
        warnings.push(
          'No existe temas/VOCABULARIO.md. Los temas solicitados se guardaron como temas_propuestos. ' +
            'Para crear la estructura de temas, usa /vault init.',
        );
      } else {
        for (const tema of input.temas.slice(0, 5)) {
          const result = resolveTopic(vocabulary, tema);
          if ('path' in result) {
            temasAplicados.push(result.path);
          } else {
            temasPropuestos.push(result.unknown.replace(/^tema\//, ''));
            if (result.suggestions.length > 0) {
              warnings.push(
                `Tema desconocido "${tema}" → guardado en temas_propuestos. ` +
                  `¿Quisiste decir: ${result.suggestions.join(', ')}?`,
              );
            } else {
              warnings.push(
                `Tema desconocido "${tema}" → guardado en temas_propuestos. Sin sugerencias cercanas.`,
              );
            }
          }
        }

        if (temasAplicados.length === 0 && temasPropuestos.length > 0) {
          warnings.push('Ningún tema es válido en el vocabulario. La nota queda sin clasificar.');
        }
      }
    } else if (!input.summary) {
      warnings.push(
        'Nota escrita sin clasificar. Para conectarla a la red de conocimiento, pasa summary y temas.',
      );
    }

    // ── Build tags list ──────────────────────────────────────────────────────
    // Priority: tema/ tags (from resolved temas) + default/provided non-tema tags
    const baseTags: string[] =
      input.tags && input.tags.length > 0
        ? input.tags.filter((t) => !t.startsWith('tema/'))
        : ['chamba'];
    const temaTags = temasAplicados.map((p) => `tema/${p}`);
    const allTags = [...temaTags, ...baseTags];

    // ── Handle workItem related linking ──────────────────────────────────────
    const autoRelated: string[] = [...(input.related ?? [])];
    if (input.workItem) {
      const relatedPaths = await this.findRelatedByWorkItem(
        input.vaultPath,
        input.workItem,
        notePath,
      );
      for (const rp of relatedPaths) {
        if (!autoRelated.includes(rp)) autoRelated.push(rp);
      }
    }

    // ── Write the note ───────────────────────────────────────────────────────
    await this.fs.mkdir(dir);

    // Build note content using upsertNoteMetadata (canonical frontmatter format)
    const bodyContent = input.content;
    const patch: Parameters<typeof upsertNoteMetadata>[1] = {
      title: input.title,
      date,
      type: input.type ?? 'nota',
      tags: allTags,
      source: 'chamba',
    };

    // Legacy callers pass `description` (the old folder-index line): it backs `summary`.
    const summary = input.summary ?? input.description;
    if (summary) patch.summary = summary.slice(0, 200);
    if (input.keywords && input.keywords.length > 0) patch.keywords = input.keywords;
    if (input.aliases && input.aliases.length > 0) patch.aliases = input.aliases;
    if (input.workItem) patch.work_item = input.workItem;
    if (input.project) patch.project = input.project;
    if (autoRelated.length > 0) patch.related = autoRelated;
    if (temasPropuestos.length > 0) patch.temas_propuestos = temasPropuestos;

    if (input.provenance) {
      if (input.provenance.author !== undefined) patch.author = input.provenance.author;
      patch.agent = input.provenance.agent;
      patch.written_at = input.provenance.written_at;
      patch.estado = 'propuesto';
      if (input.flagRevisar) patch.flag = 'revisar';
    }

    // Build initial note content (body + heading)
    const heading = `# ${input.title}\n\n${bodyContent.trim()}\n`;
    const noteContent = upsertNoteMetadata(heading, patch);

    await this.fs.writeFile(notePath, noteContent);

    // ── Back-link from existing chamba notes of same work_item ───────────────
    if (input.workItem) {
      await this.addBacklinks(
        input.vaultPath,
        input.workItem,
        notePath,
        autoRelated.filter((p) => !input.related?.includes(p)),
      );
    }

    // ── Reindex ──────────────────────────────────────────────────────────────
    const reindexer = new VaultReindexer(this.fs, input.vaultPath);
    const reindex = await reindexer.reindex();

    // ── Build response extras ─────────────────────────────────────────────────
    const arbol = vocabulary
      ? compactTopicTree(vocabulary)
      : '_No hay vocabulario de temas. Usa /vault init para crearlo._\n';

    const cercanos: ClosestTopicResult[] = vocabulary
      ? closestTopics(vocabulary, {
          title: input.title,
          summary: input.summary,
          keywords: input.keywords,
        })
      : [];

    return {
      notePath,
      warnings,
      temasAplicados,
      temasPropuestos,
      sugerencias,
      arbol,
      cercanos,
      related: autoRelated,
      reindex,
    };
  }

  /** Keep the folder's `INDEX.md` current (legacy, kept for backward compat). */
  /** Load vocabulary from the vault, or null if not present. */
  private async loadVocabulary(
    vaultPath: string,
  ): Promise<ReturnType<typeof parseVocabulary>['vocabulary'] | null> {
    const absPath = joinPath(vaultPath, VOCAB_REL_PATH);
    try {
      if (!(await this.fs.exists(absPath))) return null;
      const content = await this.fs.readFile(absPath);
      return parseVocabulary(content).vocabulary;
    } catch {
      return null;
    }
  }

  /**
   * Find vault-relative paths of notes with the same work_item.
   * Returns paths relative to the vault root, excluding the note being written.
   */
  private async findRelatedByWorkItem(
    vaultPath: string,
    workItem: string,
    excludeNotePath: string,
  ): Promise<string[]> {
    const related: string[] = [];
    const normWorkItem = workItem.toLowerCase().trim();

    await this.scanForWorkItem(vaultPath, '', normWorkItem, excludeNotePath, vaultPath, related);
    return related.sort();
  }

  private async scanForWorkItem(
    absDir: string,
    relPrefix: string,
    workItem: string,
    excludeAbsPath: string,
    vaultPath: string,
    result: string[],
  ): Promise<void> {
    const SCAN_SKIP = new Set([
      'memory',
      '.trash',
      '.obsidian',
      'temas',
      'node_modules',
      '.git',
      '.chamba-sync',
    ]);
    let entries: import('../ports/filesystem.js').DirEntry[];
    try {
      entries = await this.fs.readDir(absDir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const name = entry.name;
      const relPath = relPrefix === '' ? name : `${relPrefix}/${name}`;
      const absPath = joinPath(vaultPath, relPath);

      if (entry.isDirectory) {
        const topPart = relPath.split('/')[0] ?? '';
        if (SCAN_SKIP.has(topPart.toLowerCase())) continue;
        if (name.startsWith('.')) continue;
        await this.scanForWorkItem(
          `${absDir}/${name}`,
          relPath,
          workItem,
          excludeAbsPath,
          vaultPath,
          result,
        );
      } else if (entry.isFile && name.endsWith('.md') && name !== 'INDEX.md') {
        if (absPath === excludeAbsPath) continue;
        try {
          const content = await this.fs.readFile(absPath);
          const meta = readNoteMetadata(content, relPath);
          if (meta.work_item && meta.work_item.toLowerCase().trim() === workItem) {
            result.push(relPath);
          }
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Add back-links to existing chamba notes of the same work_item.
   * Only modifies notes with `source: chamba` — never human notes.
   */
  private async addBacklinks(
    vaultPath: string,
    _workItem: string,
    newNotePath: string,
    backLinkPaths: string[],
  ): Promise<void> {
    // newNotePath is absolute; we need vault-relative
    const vaultPrefix = vaultPath.endsWith('/') ? vaultPath : `${vaultPath}/`;
    const newNoteRelPath = newNotePath.startsWith(vaultPrefix)
      ? newNotePath.slice(vaultPrefix.length)
      : newNotePath;

    for (const relPath of backLinkPaths) {
      const absPath = joinPath(vaultPath, relPath);
      try {
        const content = await this.fs.readFile(absPath);
        const meta = readNoteMetadata(content, relPath);

        // Only edit chamba-generated notes, never human notes
        if (meta.source !== 'chamba') continue;

        const existingRelated = meta.related ?? [];
        if (existingRelated.includes(newNoteRelPath)) continue;

        const newRelated = [...existingRelated, newNoteRelPath].sort();
        const updated = upsertNoteMetadata(content, { related: newRelated });
        await this.fs.writeFile(absPath, updated);
      } catch {
        // ignore — don't crash if a file can't be updated
      }
    }
  }
}
