import type { FilesystemPort } from '../ports/filesystem.js';
import { joinPath } from '../util/path.js';
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

    if (input.vaultPath) {
      const notes = await this.searchNotes(input.vaultPath, input.task);
      relevantNotes = notes.map((n) => n.path);
      sections.push(this.notesSection(notes));
    }

    const maxChars = (input.maxTokens ?? DEFAULT_MAX_TOKENS) * 4;
    const context = clamp(sections.join('\n\n'), maxChars);
    return { context, relevantNotes };
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

  private async searchNotes(vaultPath: string, task: string): Promise<RelevantNote[]> {
    const keywords = extractKeywords(task);
    if (keywords.length === 0) return [];

    const files = await this.collectMarkdown(vaultPath);
    const scored: RelevantNote[] = [];
    for (const file of files) {
      const text = await this.tryRead(file);
      if (text === null) continue;
      const lower = text.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        score += occurrences(lower, kw);
      }
      if (score > 0) {
        scored.push({ path: file, score, snippet: firstMatchingLine(text, keywords) });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_NOTES);
  }

  private async collectMarkdown(root: string): Promise<string[]> {
    const out: string[] = [];
    const visit = async (dir: string, depth: number): Promise<void> => {
      if (depth > NOTE_SCAN_MAX_DEPTH) return;
      let entries: Awaited<ReturnType<FilesystemPort['readDir']>>;
      try {
        entries = await this.fs.readDir(dir);
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

  private async tryRead(path: string): Promise<string | null> {
    try {
      return await this.fs.readFile(path);
    } catch {
      return null;
    }
  }
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
