import { buildContextMap, type MapaStruct } from '../obsidian/knowledge/context-map.js';
import { wrapVaultData } from '../obsidian/knowledge/data-wrap.js';
import { isChambaGenerated } from '../obsidian/knowledge/derived-path.js';
import { loadGraphNotes, loadVocabulary } from '../obsidian/knowledge/vault-notes.js';
import { INDEX_FILE, parseIndexNote } from '../obsidian/vault-index.js';
import type { FilesystemPort } from '../ports/filesystem.js';
import type { RandomPort } from '../ports/random.js';
import { dirname, joinPath } from '../util/path.js';
import { extractKeywords, occurrences } from './keywords.js';
import { readRuleExcerpts } from './rules.js';
import type { Workspace } from './workspace.js';

export interface RelevantNote {
  path: string;
  /** Number of keyword hits that made this note relevant. */
  score: number;
  /** First line that matched a keyword, trimmed. */
  snippet: string;
}

export interface ContextBuildInput {
  workspace: Workspace;
  task: string;
  /** When set, search this Obsidian vault for notes relevant to the task. */
  vaultPath?: string;
  /** Include a section with each repo's coding rules (default true). */
  includeRules?: boolean;
  /** Soft cap on the produced context, in estimated tokens (~4 chars/token). */
  maxTokens?: number;
}

export interface BuiltContext {
  context: string;
  relevantNotes: string[];
  /** Present in mapa mode (vault with chamba-generated root INDEX.md). */
  mapa?: MapaStruct;
}

export type { MapaStruct };

const DEFAULT_MAX_TOKENS = 2000;
const NOTE_SCAN_MAX_DEPTH = 8;
const MAX_NOTES = 5;
const SKIP_DIRS = new Set(['.obsidian', '.trash', 'node_modules', '.git']);

/**
 * Build the context block injected into the editor model's reasoning: a summary
 * of the workspace plus, when a vault is present, the notes most relevant to the
 * task (simple keyword search — semantic search is V2).
 */
export class ContextBuilder {
  constructor(
    private readonly fs: FilesystemPort,
    private readonly random: RandomPort,
  ) {}

  async build(input: ContextBuildInput): Promise<BuiltContext> {
    const workspaceSection = this.workspaceSection(input.workspace);
    const maxChars = (input.maxTokens ?? DEFAULT_MAX_TOKENS) * 4;
    let relevantNotes: string[] = [];
    let mapa: MapaStruct | undefined;

    // ── Gate: check for chamba-generated root INDEX.md → mapa mode ──────────
    if (input.vaultPath) {
      const indexPath = joinPath(input.vaultPath, 'INDEX.md');
      let useMapa = false;
      try {
        const indexContent = await this.fs.readFile(indexPath);
        if (isChambaGenerated('INDEX.md', indexContent)) useMapa = true;
      } catch {
        // INDEX.md does not exist → legacy mode
      }

      if (useMapa) {
        // ── MAPA MODE: workspace → mapa → coding rules ─────────────────────
        const graphNotes = await loadGraphNotes(this.fs, input.vaultPath);
        const { vocabulary: vocab } = await loadVocabulary(this.fs, input.vaultPath);
        const { section: mapaSection, mapa: mapaStruct } = buildContextMap(
          graphNotes,
          vocab,
          input.task,
          { maxTokens: input.maxTokens ?? DEFAULT_MAX_TOKENS },
        );
        mapa = mapaStruct;
        relevantNotes = mapaStruct.nodos.flatMap((n) => n.notas.map((note) => note.ruta));

        const wrappedMapaSection = wrapVaultData(mapaSection, undefined, this.random.hex(12));
        const sections: string[] = [workspaceSection, wrappedMapaSection];

        const hasRules = input.includeRules !== false && input.workspace.ruleSources.length > 0;
        if (hasRules) {
          const rulesSection = await this.codingRulesSection(input.workspace);
          sections.push(rulesSection);
        }

        const full = sections.join('\n\n');
        let context = clamp(full, maxChars);

        // Detect if clamp cut the rules section: any overflow while rules are
        // present means partial rules — keep partial rules + notice, total ≤ maxChars.
        if (hasRules && full.length > maxChars) {
          mapa.reglasRecortadas = true;
          const notice = '\n\n> (reglas recortadas por presupuesto; lee los archivos de reglas)';
          context = clamp(full, maxChars - notice.length) + notice;
        }

        return { context, relevantNotes, mapa };
      }
    }

    // ── LEGACY MODE: workspace → coding rules → relevant notes ──────────────
    const sections: string[] = [workspaceSection];

    if (input.includeRules !== false && input.workspace.ruleSources.length > 0) {
      sections.push(await this.codingRulesSection(input.workspace));
    }

    if (input.vaultPath) {
      const notes = await this.searchNotes(input.vaultPath, input.task);
      relevantNotes = notes.map((n) => n.path);
      const notesSection = this.notesSection(notes);

      // Clamp the INNER content before wrapping, not the wrapped block — the
      // final `<<</vault-datos:<nonce>>>` delimiter must never be cut off by a
      // later clamp, or the model loses the boundary that marks third-party
      // data as data, not instructions (CHAMBA-021 S15 prompt-injection defense).
      const nonce = this.random.hex(12);
      const otherSections = sections.join('\n\n');
      const separator = otherSections.length > 0 ? 2 : 0; // the '\n\n' joiner
      // Wrapping content of length N adds exactly N chars vs. wrapping '' —
      // content replaces one line as-is, no extra separators are added.
      const emptyWrappedLen = wrapVaultData('', undefined, nonce).length;
      const notesBudget = maxChars - otherSections.length - separator - emptyWrappedLen;

      if (notesBudget >= 0) {
        const clampedNotesSection = clamp(notesSection, notesBudget);
        sections.push(wrapVaultData(clampedNotesSection, undefined, nonce));
      }
      // else: not even an EMPTY wrapped block (open tag + warning + close tag)
      // fits the budget — omit the vault-data section entirely rather than
      // ever truncate mid-delimiter.
    }

    // Safety net only: with the budgeting above this should no longer need to
    // cut into the wrapped vault-data block's closing delimiter.
    const context = clamp(sections.join('\n\n'), maxChars);
    return { context, relevantNotes };
  }

  /** Each repo's coding rules (read fresh, clamped), non-exclusive across editors. */
  private async codingRulesSection(ws: Workspace): Promise<string> {
    const excerpts = await readRuleExcerpts(this.fs, ws.root, ws.ruleSources);
    if (excerpts.length === 0) return '## Coding rules\n\nNo readable rule files.';
    const lines = [
      '## Coding rules',
      '',
      'Follow these per-repo rules (any editor). Read the full file for details:',
      '',
    ];
    for (const { source, excerpt } of excerpts) {
      lines.push(`### \`${source.path}\` — ${source.editor} (${source.repo})`);
      lines.push('', excerpt, '');
    }
    return lines.join('\n').trimEnd();
  }

  private workspaceSection(ws: Workspace): string {
    const lines = ['## Workspace context', '', ws.description.trim()];
    if (ws.languages.length > 0) lines.push('', `Languages: ${ws.languages.join(', ')}`);
    if (ws.framework) lines.push(`Framework: ${ws.framework}`);
    if (ws.projects.length > 0) {
      lines.push('', 'Projects:');
      for (const p of ws.projects) lines.push(`- ${p.name} (\`${p.path}\`)`);
    }
    return lines.join('\n');
  }

  private notesSection(notes: RelevantNote[]): string {
    if (notes.length === 0) {
      return '## Relevant notes\n\nNo vault notes matched this task.';
    }
    const lines = ['## Relevant notes', ''];
    for (const note of notes) {
      lines.push(`- \`${note.path}\` — ${note.snippet}`);
    }
    return lines.join('\n');
  }

  /**
   * Index-first: match against the cheap per-folder `INDEX.md` files and only
   * open the top notes for a snippet. If the indexes yield nothing (or don't
   * exist yet — a legacy vault), fall back to a full body scan so recall never
   * regresses. Self-healing: the writer rebuilds indexes as notes are added.
   */
  private async searchNotes(vaultPath: string, task: string): Promise<RelevantNote[]> {
    const keywords = extractKeywords(task);
    if (keywords.length === 0) return [];

    const fromIndex = await this.searchIndex(vaultPath, keywords);
    if (fromIndex.length > 0) return fromIndex;

    return this.fullScan(vaultPath, keywords);
  }

  /** Rank index entries by keyword hits on title+description; read only the top notes. */
  private async searchIndex(vaultPath: string, keywords: string[]): Promise<RelevantNote[]> {
    const entries = await this.collectIndexEntries(vaultPath);
    if (entries.length === 0) return [];

    const ranked = entries
      .map((e) => ({ e, score: scoreText(`${e.title}\n${e.description}`.toLowerCase(), keywords) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_NOTES);

    const out: RelevantNote[] = [];
    for (const { e, score } of ranked) {
      const text = await this.tryRead(e.notePath);
      let snippet = e.description || '(matched)';
      if (text !== null) {
        const line = firstMatchingLine(text, keywords);
        if (line !== '(matched)') snippet = line;
      }
      out.push({ path: e.notePath, score, snippet });
    }
    return out;
  }

  /** Legacy/fallback path: read every note body, skipping the index files themselves. */
  private async fullScan(vaultPath: string, keywords: string[]): Promise<RelevantNote[]> {
    const files = (await listVaultNotes(this.fs, vaultPath)).filter(
      (p) => !p.endsWith(`/${INDEX_FILE}`),
    );
    const scored: RelevantNote[] = [];
    for (const file of files) {
      const text = await this.tryRead(file);
      if (text === null) continue;
      const score = scoreText(text.toLowerCase(), keywords);
      if (score > 0) {
        scored.push({ path: file, score, snippet: firstMatchingLine(text, keywords) });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_NOTES);
  }

  private async collectIndexEntries(
    vaultPath: string,
  ): Promise<Array<{ notePath: string; title: string; description: string }>> {
    const indexFiles = (await listVaultNotes(this.fs, vaultPath)).filter((p) =>
      p.endsWith(`/${INDEX_FILE}`),
    );
    const out: Array<{ notePath: string; title: string; description: string }> = [];
    for (const idx of indexFiles) {
      const text = await this.tryRead(idx);
      if (text === null) continue;
      const dir = dirname(idx);
      for (const e of parseIndexNote(text)) {
        out.push({ notePath: joinPath(dir, e.path), title: e.title, description: e.description });
      }
    }
    return out;
  }

  private async tryRead(path: string): Promise<string | null> {
    try {
      return await this.fs.readFile(path);
    } catch {
      return null;
    }
  }
}

/**
 * All markdown notes under a vault (the same set `chamba_load_context` searches),
 * skipping `.obsidian`, `.trash`, etc. Useful to show what chamba actually sees.
 */
export async function listVaultNotes(fs: FilesystemPort, root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > NOTE_SCAN_MAX_DEPTH) return;
    let entries: Awaited<ReturnType<FilesystemPort['readDir']>>;
    try {
      entries = await fs.readDir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = joinPath(dir, entry.name);
      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await visit(full, depth + 1);
      } else if (entry.name.toLowerCase().endsWith('.md')) {
        out.push(full);
      }
    }
  };
  await visit(root, 0);
  return out;
}

// --- helpers ------------------------------------------------------------------

/** Total keyword hits in a (already lower-cased) haystack. */
function scoreText(haystack: string, keywords: string[]): number {
  let score = 0;
  for (const kw of keywords) score += occurrences(haystack, kw);
  return score;
}

function firstMatchingLine(text: string, keywords: string[]): string {
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const lower = line.toLowerCase();
    if (keywords.some((kw) => lower.includes(kw))) {
      return line.length > 120 ? `${line.slice(0, 117)}...` : line;
    }
  }
  return '(matched)';
}

function clamp(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
