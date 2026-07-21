import type { FilesystemPort } from '../ports/filesystem.js';
import { basename, extname, joinPath } from '../util/path.js';
import type {
  Design,
  DesignAsset,
  DesignAssetKind,
  DesignConventions,
  DesignRef,
} from './design.js';

/** The `.chamba/` subdirectory that holds design-source pointer files + conventions. */
export const DESIGN_DIR = 'design';
/** The UI-architecture preference file inside the design dir. */
export const CONVENTIONS_FILE = 'conventions.json';

const DEFAULT_MAX_DESIGNS = 3;
const MAX_ASSETS = 60;
const SPEC_TOTAL_BUDGET = 2400;
const SPEC_PER_BUDGET = 900;

/**
 * Common UI architectures the planner can offer when asking (and saving) a
 * preference. Suggestions, not a closed set — any string is accepted/stored.
 */
export const KNOWN_ARCHITECTURES = {
  web: [
    { id: 'atomic', label: 'Atomic Design (atoms/molecules/organisms/templates/pages)' },
    { id: 'feature-sliced', label: 'Feature-Sliced Design (FSD)' },
    { id: 'component-driven', label: 'Component-driven (flat components/ + Storybook)' },
    { id: 'by-route', label: 'By route/page' },
  ],
  mobile: [
    { id: 'screens', label: 'Screens + components (expo-router file-based)' },
    { id: 'atomic', label: 'Atomic Design' },
    { id: 'feature-sliced', label: 'Feature-Sliced Design (FSD)' },
  ],
} as const;

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif']);
const SPEC_EXTS = new Set(['.md', '.txt', '.markdown']);
const PROTOTYPE_EXTS = new Set(['.html', '.htm', '.zip']);

/** Parse a design pointer's frontmatter into an index entry. Requires a `name`. */
export function parseDesignFrontmatter(content: string, path: string): DesignRef | null {
  const split = splitFrontmatter(content);
  if (!split) return null;
  const name = fmValue(split.frontmatter, 'name');
  if (!name) return null;
  const ref: DesignRef = {
    name,
    description: fmValue(split.frontmatter, 'description') ?? '',
    path,
  };
  const figma = fmValue(split.frontmatter, 'figma');
  const folder = fmValue(split.frontmatter, 'folder');
  const prototype = fmValue(split.frontmatter, 'prototype');
  if (figma) ref.figma = figma;
  if (folder) ref.folder = folder;
  if (prototype) ref.prototype = prototype;
  return ref;
}

/**
 * Scan design directories for `*.md` pointer files and return their index entries.
 * First `name` wins, so pass the project dir before the global one.
 */
export async function collectDesignRefs(fs: FilesystemPort, dirs: string[]): Promise<DesignRef[]> {
  const refs: DesignRef[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const name of await designFiles(fs, dir)) {
      const path = joinPath(dir, name);
      const content = await readIfExists(fs, path);
      if (content === null) continue;
      const ref = parseDesignFrontmatter(content, path);
      if (!ref || seen.has(ref.name)) continue;
      seen.add(ref.name);
      refs.push(ref);
    }
  }
  return refs;
}

/** Rank design sources by how well name/description match the task (no LLM). */
export function rankDesigns(
  task: string,
  refs: DesignRef[],
  max: number = DEFAULT_MAX_DESIGNS,
): DesignRef[] {
  const keywords = extractKeywords(task);
  if (keywords.length === 0) return [];
  return refs
    .map((ref) => ({
      ref,
      score: scoreText(`${ref.name} ${ref.description}`.toLowerCase(), keywords),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, max))
    .map((x) => x.ref);
}

/**
 * Resolve a design source: its brief (body) plus the assets found in the linked
 * folder and the frontmatter prototype. `homedir` expands a leading `~` in paths.
 * Read-only — chamba lists and reads, it never runs or interprets the design.
 */
export async function readDesign(
  fs: FilesystemPort,
  ref: DesignRef,
  homedir: string,
): Promise<Design | null> {
  const content = await readIfExists(fs, ref.path);
  if (content === null) return null;
  const parsed = parseDesignFrontmatter(content, ref.path);
  if (!parsed) return null;
  const split = splitFrontmatter(content);
  const brief = (split?.body ?? '').trim();

  const assets: DesignAsset[] = [];
  const seenPaths = new Set<string>();
  let specBudget = SPEC_TOTAL_BUDGET;

  if (parsed.folder) {
    const folderAbs = expandHome(parsed.folder, homedir);
    for (const entry of await folderEntries(fs, folderAbs)) {
      if (assets.length >= MAX_ASSETS) break;
      const path = joinPath(folderAbs, entry);
      const kind = classify(entry);
      const asset: DesignAsset = { kind, path, name: entry };
      if (kind === 'spec' && specBudget > 0) {
        const text = await readIfExists(fs, path);
        if (text !== null) {
          const excerpt = text.trim().slice(0, Math.min(SPEC_PER_BUDGET, specBudget));
          asset.excerpt = excerpt;
          specBudget -= excerpt.length;
        }
      }
      seenPaths.add(path);
      assets.push(asset);
    }
  }

  if (parsed.prototype) {
    const protoAbs = expandHome(parsed.prototype, homedir);
    if (!seenPaths.has(protoAbs)) {
      assets.push({ kind: 'prototype', path: protoAbs, name: basename(protoAbs) });
    }
  }

  return { ...parsed, brief, assets };
}

/** Read the saved UI-architecture preference from the given design dirs (project first). */
export async function loadDesignConventions(
  fs: FilesystemPort,
  dirs: string[],
): Promise<DesignConventions> {
  const out: DesignConventions = {};
  for (const dir of dirs) {
    const parsed = await readConventions(fs, joinPath(dir, CONVENTIONS_FILE));
    if (!parsed) continue;
    if (out.web === undefined && typeof parsed.web === 'string') out.web = parsed.web;
    if (out.mobile === undefined && typeof parsed.mobile === 'string') out.mobile = parsed.mobile;
  }
  return out;
}

/** Merge a preference patch into `<dir>/conventions.json` and return the result. */
export async function saveDesignConventions(
  fs: FilesystemPort,
  dir: string,
  patch: DesignConventions,
): Promise<DesignConventions> {
  const path = joinPath(dir, CONVENTIONS_FILE);
  const current = (await readConventions(fs, path)) ?? {};
  const merged: DesignConventions = { ...current };
  if (patch.web !== undefined) merged.web = patch.web;
  if (patch.mobile !== undefined) merged.mobile = patch.mobile;
  await fs.mkdir(dir);
  await fs.writeFile(path, `${JSON.stringify(merged, null, 2)}\n`);
  return merged;
}

// --- helpers ------------------------------------------------------------------

async function designFiles(fs: FilesystemPort, dir: string): Promise<string[]> {
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

async function folderEntries(fs: FilesystemPort, dir: string): Promise<string[]> {
  try {
    const entries = await fs.readDir(dir);
    return entries
      .filter((e) => e.isFile)
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function classify(name: string): DesignAssetKind {
  const ext = extname(name).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (PROTOTYPE_EXTS.has(ext)) return 'prototype';
  if (SPEC_EXTS.has(ext)) return 'spec';
  return 'other';
}

function expandHome(path: string, homedir: string): string {
  if (path === '~') return homedir;
  if (path.startsWith('~/')) return joinPath(homedir, path.slice(2));
  return path;
}

async function readConventions(
  fs: FilesystemPort,
  path: string,
): Promise<DesignConventions | null> {
  const text = await readIfExists(fs, path);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const rec = parsed as Record<string, unknown>;
    const out: DesignConventions = {};
    if (typeof rec.web === 'string') out.web = rec.web;
    if (typeof rec.mobile === 'string') out.mobile = rec.mobile;
    return out;
  } catch {
    return null;
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
