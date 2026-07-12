import type { FilesystemPort } from '../ports/filesystem.js';
import { joinPath } from '../util/path.js';
import type { Skill, SkillRef } from './skill.js';

/** The `.chamba/` subdirectory that holds skill/playbook markdown files. */
export const SKILLS_DIR = 'skills';

const DEFAULT_MAX_SKILLS = 3;

/**
 * Parse a skill file's frontmatter into an index entry. Requires at least a
 * `name`. Returns null for a file without valid frontmatter (so plain notes and
 * READMEs in the skills folder are ignored). No LLM — plain text parsing.
 */
export function parseSkillFrontmatter(content: string, path: string): SkillRef | null {
  const split = splitFrontmatter(content);
  if (!split) return null;
  const name = fmValue(split.frontmatter, 'name');
  if (!name) return null;
  const description = fmValue(split.frontmatter, 'description') ?? '';
  const scope = fmValue(split.frontmatter, 'scope');
  return scope ? { name, description, scope, path } : { name, description, path };
}

/**
 * Scan the given skill directories for `*.md` files and return their index
 * entries. Directories are tried in order and the first `name` wins, so pass the
 * project dir before the global one to let a project skill shadow a personal one.
 */
export async function collectSkillRefs(fs: FilesystemPort, dirs: string[]): Promise<SkillRef[]> {
  const refs: SkillRef[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const name of await skillFiles(fs, dir)) {
      const path = joinPath(dir, name);
      const content = await readIfExists(fs, path);
      if (content === null) continue;
      const ref = parseSkillFrontmatter(content, path);
      if (!ref || seen.has(ref.name)) continue;
      seen.add(ref.name);
      refs.push(ref);
    }
  }
  return refs;
}

/** Rank skills by how well their name/description/scope match the task (no LLM). */
export function rankSkills(
  task: string,
  refs: SkillRef[],
  max: number = DEFAULT_MAX_SKILLS,
): SkillRef[] {
  const keywords = extractKeywords(task);
  if (keywords.length === 0) return [];
  return refs
    .map((ref) => ({
      ref,
      score: scoreText(`${ref.name} ${ref.description} ${ref.scope ?? ''}`.toLowerCase(), keywords),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, max))
    .map((x) => x.ref);
}

/** Read a skill's full body (the text after the frontmatter). */
export async function readSkill(fs: FilesystemPort, path: string): Promise<Skill | null> {
  const content = await readIfExists(fs, path);
  if (content === null) return null;
  const ref = parseSkillFrontmatter(content, path);
  if (!ref) return null;
  const split = splitFrontmatter(content);
  return { ...ref, body: (split?.body ?? '').trim() };
}

// --- helpers ------------------------------------------------------------------

async function skillFiles(fs: FilesystemPort, dir: string): Promise<string[]> {
  try {
    const entries = await fs.readDir(dir);
    return entries
      .filter(
        (e) =>
          e.isFile &&
          e.name.toLowerCase().endsWith('.md') &&
          e.name.toLowerCase() !== 'readme.md' &&
          e.name !== 'INDEX.md',
      )
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function readIfExists(fs: FilesystemPort, path: string): Promise<string | null> {
  try {
    return await fs.readFile(path);
  } catch {
    return null;
  }
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } | null {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  if (!m) return null;
  return { frontmatter: m[1] ?? '', body: m[2] ?? '' };
}

function fmValue(frontmatter: string, key: string): string | undefined {
  const re = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'im');
  const m = re.exec(frontmatter);
  if (!m) return undefined;
  const value = stripQuotes((m[1] ?? '').trim());
  return value.length > 0 ? value : undefined;
}

function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'add',
  'new',
  'use',
  'los',
  'las',
  'una',
  'con',
  'por',
  'para',
  'del',
  'que',
  'como',
  'una',
  'este',
]);

function extractKeywords(task: string): string[] {
  const seen = new Set<string>();
  for (const raw of task.toLowerCase().split(/[^a-z0-9áéíóúñ]+/i)) {
    const w = raw.trim();
    if (w.length >= 3 && !STOPWORDS.has(w)) seen.add(w);
  }
  return [...seen];
}

function scoreText(haystack: string, keywords: string[]): number {
  let score = 0;
  for (const kw of keywords) {
    let idx = haystack.indexOf(kw);
    while (idx !== -1) {
      score++;
      idx = haystack.indexOf(kw, idx + kw.length);
    }
  }
  return score;
}
