import type { FilesystemPort } from '../ports/filesystem.js';
import { joinPath } from '../util/path.js';

// Coding-rule conventions across editors. chamba reads ALL of them, non-exclusively:
// using Claude Code doesn't mean ignoring `.cursor/rules` or `.trae`. Extensible —
// add an entry to support a new editor's convention.

export interface RuleConvention {
  editor: string;
  /** Path relative to a repo root. */
  path: string;
  kind: 'file' | 'dir';
}

export const RULE_SOURCES: readonly RuleConvention[] = [
  { editor: 'Cursor', path: '.cursor/rules', kind: 'dir' },
  { editor: 'Cursor', path: '.cursorrules', kind: 'file' },
  { editor: 'Claude Code', path: 'CLAUDE.md', kind: 'file' },
  { editor: 'Claude Code', path: '.claude/rules', kind: 'dir' },
  { editor: 'Windsurf', path: '.windsurfrules', kind: 'file' },
  { editor: 'Windsurf', path: '.windsurf/rules', kind: 'dir' },
  { editor: 'Trae', path: '.trae/rules', kind: 'dir' },
  { editor: 'Trae', path: '.trae/project_rules.md', kind: 'file' },
  { editor: 'GitHub Copilot', path: '.github/copilot-instructions.md', kind: 'file' },
  { editor: 'Cline', path: '.clinerules', kind: 'file' },
  { editor: 'Gemini CLI', path: 'GEMINI.md', kind: 'file' },
  { editor: 'JetBrains Junie', path: '.junie/guidelines.md', kind: 'file' },
  { editor: 'Kiro', path: '.kiro/steering', kind: 'dir' },
  { editor: 'Zed', path: '.rules', kind: 'file' },
  { editor: 'Agents', path: 'AGENTS.md', kind: 'file' },
];

/** A concrete rule file found in a repo. */
export interface RuleSource {
  /** Repo path relative to the workspace root (`.` for the root itself). */
  repo: string;
  editor: string;
  /** Rule file path relative to the workspace root. */
  path: string;
}

export interface RuleExcerpt {
  source: RuleSource;
  excerpt: string;
}

/** Markdown-ish rule files we read from a rules directory. */
function isRuleFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.mdc');
}

async function isDir(fs: FilesystemPort, path: string): Promise<boolean> {
  try {
    await fs.readDir(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Discover coding-rule files across the workspace root and each repo, for every
 * editor convention in the catalog. Non-exclusive: a repo can match several.
 * `repoDirs` are paths relative to the workspace root (`.` for the root).
 */
export async function detectRuleSources(
  fs: FilesystemPort,
  workspaceRoot: string,
  repoDirs: string[],
): Promise<RuleSource[]> {
  const found: RuleSource[] = [];
  const seen = new Set<string>();

  const add = (repo: string, editor: string, relPath: string): void => {
    if (seen.has(relPath)) return;
    seen.add(relPath);
    found.push({ repo, editor, path: relPath });
  };

  for (const repo of repoDirs) {
    const repoAbs = repo === '.' ? workspaceRoot : joinPath(workspaceRoot, repo);
    for (const conv of RULE_SOURCES) {
      const abs = joinPath(repoAbs, conv.path);
      const rel = repo === '.' ? conv.path : joinPath(repo, conv.path);

      if (conv.kind === 'file') {
        if (await fs.exists(abs)) add(repo, conv.editor, rel);
        continue;
      }
      // dir: list the rule files inside
      if (!(await isDir(fs, abs))) continue;
      let entries: Awaited<ReturnType<FilesystemPort['readDir']>>;
      try {
        entries = await fs.readDir(abs);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile && isRuleFile(entry.name)) {
          add(repo, conv.editor, joinPath(rel, entry.name));
        }
      }
    }
  }

  return found;
}

/**
 * Read each rule file fresh and return a clamped excerpt, bounded by a total
 * budget so rules never crowd out the rest of the context.
 */
export async function readRuleExcerpts(
  fs: FilesystemPort,
  workspaceRoot: string,
  sources: RuleSource[],
  opts: { maxCharsPerRule?: number; totalBudget?: number } = {},
): Promise<RuleExcerpt[]> {
  const maxPer = opts.maxCharsPerRule ?? 400;
  const total = opts.totalBudget ?? 1500;
  const out: RuleExcerpt[] = [];
  let used = 0;

  for (const source of sources) {
    if (used >= total) break;
    let text: string;
    try {
      text = await fs.readFile(joinPath(workspaceRoot, source.path));
    } catch {
      continue;
    }
    const budget = Math.min(maxPer, total - used);
    const excerpt = clampExcerpt(text.trim(), budget);
    used += excerpt.length;
    out.push({ source, excerpt });
  }

  return out;
}

function clampExcerpt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
