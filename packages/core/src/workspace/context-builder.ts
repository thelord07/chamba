import { INDEX_FILE, parseIndexNote } from '../obsidian/vault-index.js';
import type { FilesystemPort } from '../ports/filesystem.js';
import { dirname, joinPath } from '../util/path.js';
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
}

const DEFAULT_MAX_TOKENS = 2000;
const NOTE_SCAN_MAX_DEPTH = 8;
const MAX_NOTES = 5;
const SKIP_DIRS = new Set(['.obsidian', '.trash', 'node_modules', '.git']);

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'add',
  'use',
  'that',
  'this',
  'into',
  'from',
  'all',
  'can',
  'should',
  'una',
  'unos',
  'para',
  'con',
  'los',
  'las',
  'del',
]);

/**
 * Build the context block injected into the editor model's reasoning: a summary
 * of the workspace plus, when a vault is present, the notes most relevant to the
 * task (simple keyword search — semantic search is V2).
 */
export class ContextBuilder {
  constructor(private readonly fs: FilesystemPort) {}

  async build(input: ContextBuildInput): Promise<BuiltContext> {
    const sections: string[] = [this.workspaceSection(input.workspace)];
    let relevantNotes: string[] = [];

    if (input.includeRules !== false && input.workspace.ruleSources.length > 0) {
      sections.push(await this.codingRulesSection(input.workspace));
    }

    if (input.vaultPath) {
      const notes = await this.searchNotes(input.vaultPath, input.task);
      relevantNotes = notes.map((n) => n.path);
      sections.push(this.notesSection(notes));
    }

    const maxChars = (input.maxTokens ?? DEFAULT_MAX_TOKENS) * 4;
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

function extractKeywords(task: string): string[] {
  const seen = new Set<string>();
  for (const raw of task.toLowerCase().split(/[^a-z0-9áéíóúñ]+/i)) {
    const w = raw.trim();
    if (w.length >= 3 && !STOPWORDS.has(w)) seen.add(w);
  }
  return [...seen];
}

function occurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = haystack.indexOf(needle);
  while (idx !== -1) {
    count++;
    idx = haystack.indexOf(needle, idx + needle.length);
  }
  return count;
}

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
