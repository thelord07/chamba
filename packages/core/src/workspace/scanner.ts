import type { FilesystemPort } from '../ports/filesystem.js';
import { basename, dirname, extname, joinPath } from '../util/path.js';
import { detectGitRepos } from '../worktree/git-repo-detector.js';
import { detectRuleSources } from './rules.js';
import type {
  AuthFinding,
  MobileFinding,
  MobilePlatform,
  MobileTarget,
  ProjectAuth,
  ProjectRef,
  Workspace,
} from './workspace.js';

const MAX_DEPTH = 6;

/** Always skipped, even if not present in .gitignore. */
const DEFAULT_IGNORES = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '.DS_Store',
];

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.mts': 'TypeScript',
  '.cts': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.rb': 'Ruby',
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.php': 'PHP',
  '.cs': 'C#',
  '.swift': 'Swift',
  '.c': 'C',
  '.cpp': 'C++',
  '.sh': 'Shell',
};

const MANIFEST_FILES = new Set(['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']);

// Dependency name -> framework label. First match wins (ordered by specificity).
// Expo/React Native go before `react` so a mobile app isn't mislabelled "React".
const FRAMEWORKS: ReadonlyArray<readonly [string, string]> = [
  ['next', 'Next.js'],
  ['@nestjs/core', 'NestJS'],
  ['@angular/core', 'Angular'],
  ['remix', 'Remix'],
  ['astro', 'Astro'],
  ['expo', 'Expo (React Native)'],
  ['react-native', 'React Native'],
  ['svelte', 'Svelte'],
  ['vue', 'Vue'],
  ['react', 'React'],
  ['hono', 'Hono'],
  ['fastify', 'Fastify'],
  ['express', 'Express'],
];

// Mobile E2E tooling: dependency name -> label. Substring/prefix aware below.
const MOBILE_E2E_LIBS: ReadonlyArray<readonly [string, string]> = [
  ['detox', 'Detox'],
  ['@wdio/', 'Appium/WebdriverIO'],
  ['webdriverio', 'Appium/WebdriverIO'],
  ['appium', 'Appium/WebdriverIO'],
];

const PY_FRAMEWORKS: ReadonlyArray<readonly [string, string]> = [
  ['django', 'Django'],
  ['fastapi', 'FastAPI'],
  ['flask', 'Flask'],
];

// Auth signal -> provider label. First match wins (specific → generic). A signal
// ending in `/` matches a scoped prefix; otherwise it matches the exact name or a
// `name-*` family (e.g. `passport` also matches `passport-local`).
const AUTH_LIBS: ReadonlyArray<readonly [string, string]> = [
  ['@auth0/', 'Auth0'],
  ['auth0', 'Auth0'],
  ['express-openid-connect', 'Auth0'],
  ['@clerk/', 'Clerk'],
  ['@aws-sdk/client-cognito-identity-provider', 'AWS Cognito'],
  ['amazon-cognito-identity-js', 'AWS Cognito'],
  ['aws-amplify', 'AWS Amplify (Cognito)'],
  ['@supabase/', 'Supabase Auth'],
  ['@firebase/', 'Firebase Auth'],
  ['firebase-admin', 'Firebase Auth'],
  ['firebase', 'Firebase Auth'],
  ['next-auth', 'Auth.js (NextAuth)'],
  ['@auth/core', 'Auth.js'],
  ['@okta/', 'Okta'],
  ['@workos-inc/node', 'WorkOS'],
  ['@kinde-oss/', 'Kinde'],
  ['@stytch/', 'Stytch'],
  ['lucia', 'Lucia'],
  ['passport', 'Passport'],
  ['jsonwebtoken', 'JWT (jsonwebtoken)'],
  ['jose', 'JWT (jose)'],
];

// Python auth signals matched as substrings of pyproject.toml (like PY_FRAMEWORKS).
const PY_AUTH_LIBS: ReadonlyArray<readonly [string, string]> = [
  ['authlib', 'Authlib'],
  ['fastapi-users', 'FastAPI Users'],
  ['django-allauth', 'django-allauth'],
  ['python-jose', 'JWT (python-jose)'],
  ['pyjwt', 'JWT (PyJWT)'],
  ['firebase-admin', 'Firebase Auth'],
];

interface IgnoreRule {
  re: RegExp;
  anchored: boolean;
  dirOnly: boolean;
}

interface ScanAcc {
  topDirs: Set<string>;
  exts: Set<string>;
  manifests: string[]; // relative paths to manifest files
}

export class WorkspaceScanner {
  constructor(private readonly fs: FilesystemPort) {}

  async scan(root: string): Promise<Workspace> {
    const rules = await this.loadIgnoreRules(root);
    const acc: ScanAcc = { topDirs: new Set(), exts: new Set(), manifests: [] };
    await this.walk(root, '', 0, rules, acc);

    const languages = this.detectLanguages(acc.exts);
    const projects = await this.detectProjects(root, acc.manifests, languages);
    const rootProject = projects.find((p) => p.path === '.');
    const framework = rootProject?.framework ?? projects.find((p) => p.framework)?.framework;
    const conventions = await this.detectConventions(root);
    const auth = aggregateAuth(projects);
    const mobile = aggregateMobile(projects);
    const description = await this.detectDescription(root, rootProject, framework, languages);

    // Repos to scan for coding rules: the root, each child git repo, and each
    // manifest-based project (deduped).
    const repoDirs = [
      ...new Set(['.', ...(await detectGitRepos(this.fs, root)), ...projects.map((p) => p.path)]),
    ];
    const ruleSources = await detectRuleSources(this.fs, root, repoDirs);

    return {
      root,
      description,
      languages,
      framework,
      conventions,
      auth,
      ...(mobile.length > 0 ? { mobile } : {}),
      projects,
      ruleSources,
      folderMap: [...acc.topDirs].sort(),
    };
  }

  private async loadIgnoreRules(root: string): Promise<IgnoreRule[]> {
    const patterns = [...DEFAULT_IGNORES];
    for (const file of ['.gitignore', '.dockerignore']) {
      const text = await this.tryRead(joinPath(root, file));
      if (text !== null) patterns.push(...parseIgnoreFile(text));
    }
    return patterns.map(compileIgnore);
  }

  private async walk(
    root: string,
    rel: string,
    depth: number,
    rules: IgnoreRule[],
    acc: ScanAcc,
  ): Promise<void> {
    if (depth > MAX_DEPTH) return;
    const dirPath = rel.length > 0 ? joinPath(root, rel) : root;
    let entries: Awaited<ReturnType<FilesystemPort['readDir']>>;
    try {
      entries = await this.fs.readDir(dirPath);
    } catch {
      return;
    }

    // A linked git worktree has a `.git` *file* (a gitdir pointer), not a `.git`
    // directory. Skip nested worktrees so their checked-out copies don't show up
    // as separate projects. If chamba was pointed straight at a worktree
    // (depth 0), respect that and scan it anyway.
    if (depth > 0 && entries.some((e) => e.name === '.git' && e.isFile)) return;

    for (const entry of entries) {
      const childRel = rel.length > 0 ? `${rel}/${entry.name}` : entry.name;
      if (isIgnored(rules, childRel, entry.isDirectory)) continue;

      if (entry.isDirectory) {
        if (depth === 0) acc.topDirs.add(entry.name);
        await this.walk(root, childRel, depth + 1, rules, acc);
      } else {
        const ext = extname(entry.name);
        if (ext.length > 0) acc.exts.add(ext);
        if (MANIFEST_FILES.has(entry.name)) acc.manifests.push(childRel);
      }
    }
  }

  private detectLanguages(exts: Set<string>): string[] {
    const langs = new Set<string>();
    for (const ext of exts) {
      const lang = LANGUAGE_BY_EXT[ext];
      if (lang) langs.add(lang);
    }
    return [...langs].sort();
  }

  private async detectProjects(
    root: string,
    manifests: string[],
    languages: string[],
  ): Promise<ProjectRef[]> {
    const projects: ProjectRef[] = [];
    for (const manifestRel of manifests) {
      const dir = dirname(manifestRel);
      const name = basename(manifestRel);
      const project = await this.readProject(root, manifestRel, dir, name, languages);
      if (project) projects.push(project);
    }
    // Root project first, then by path.
    projects.sort((a, b) =>
      a.path === '.' ? -1 : b.path === '.' ? 1 : a.path.localeCompare(b.path),
    );
    return projects;
  }

  private async readProject(
    root: string,
    manifestRel: string,
    dir: string,
    manifestName: string,
    languages: string[],
  ): Promise<ProjectRef | null> {
    const path = dir.length === 0 ? '.' : dir;
    const fallbackName = path === '.' ? basename(root) : basename(dir);

    if (manifestName === 'package.json') {
      const text = await this.tryRead(joinPath(root, manifestRel));
      const pkg = text !== null ? safeJsonParse(text) : null;
      const name = typeof pkg?.name === 'string' && pkg.name.length > 0 ? pkg.name : fallbackName;
      const language = languages.includes('TypeScript') ? 'TypeScript' : 'JavaScript';
      const auth = detectNodeAuth(pkg);
      const mobile = await this.detectMobile(root, path, pkg);
      return {
        name,
        path,
        language,
        framework: detectNodeFramework(pkg),
        ...(auth.length > 0 ? { auth } : {}),
        ...(mobile ? { mobile } : {}),
      };
    }
    if (manifestName === 'pyproject.toml') {
      const text = (await this.tryRead(joinPath(root, manifestRel))) ?? '';
      const auth = detectPyAuth(text);
      return {
        name: tomlName(text) ?? fallbackName,
        path,
        language: 'Python',
        framework: detectPyFramework(text),
        ...(auth.length > 0 ? { auth } : {}),
      };
    }
    if (manifestName === 'Cargo.toml') {
      const text = (await this.tryRead(joinPath(root, manifestRel))) ?? '';
      return { name: tomlName(text) ?? fallbackName, path, language: 'Rust' };
    }
    if (manifestName === 'go.mod') {
      return { name: fallbackName, path, language: 'Go' };
    }
    return null;
  }

  /**
   * Detect a React Native / Expo app from a project's manifest + nearby files.
   * Returns undefined for a non-mobile project. Detection only — chamba never
   * runs a simulator, it just reports what the project targets.
   */
  private async detectMobile(
    root: string,
    projPath: string,
    pkg: Record<string, unknown> | null,
  ): Promise<MobileTarget | undefined> {
    if (!pkg) return undefined;
    const deps = {
      ...(asRecord(pkg.dependencies) ?? {}),
      ...(asRecord(pkg.devDependencies) ?? {}),
    };
    const depNames = Object.keys(deps);
    const hasExpo = depNames.some((d) => d === 'expo' || d.startsWith('@expo/'));
    const hasReactNative = 'react-native' in deps;
    if (!hasExpo && !hasReactNative) return undefined;

    const dir = projPath === '.' ? root : joinPath(root, projPath);
    const hasIos = await this.pathExists(joinPath(dir, 'ios'));
    const hasAndroid = await this.pathExists(joinPath(dir, 'android'));
    const hasDevClient = 'expo-dev-client' in deps;
    const hasEas = await this.pathExists(joinPath(dir, 'eas.json'));

    const platforms: MobilePlatform[] = [];
    if (hasIos) platforms.push('ios');
    if (hasAndroid) platforms.push('android');
    // Managed Expo has no native dirs but still targets both platforms.
    if (platforms.length === 0) platforms.push('ios', 'android');

    const e2e = detectMobileE2e(depNames);
    if (await this.pathExists(joinPath(dir, '.maestro'))) e2e.push('Maestro');

    const target: MobileTarget = {
      reactNative: hasReactNative,
      platforms,
      hasEas,
      hasDevClient,
      e2e,
    };
    if (hasExpo) target.expo = hasIos && hasAndroid ? 'bare' : hasDevClient ? 'bare' : 'managed';
    return target;
  }

  private async pathExists(path: string): Promise<boolean> {
    try {
      return await this.fs.exists(path);
    } catch {
      return false;
    }
  }

  private async detectConventions(root: string): Promise<string[]> {
    const conventions: string[] = [];
    const has = (file: string): Promise<boolean> => this.fs.exists(joinPath(root, file));

    if (await has('pnpm-workspace.yaml')) conventions.push('pnpm workspaces (monorepo)');
    if (await has('biome.json')) conventions.push('Biome for lint + format');
    if ((await has('vitest.config.ts')) || (await has('vitest.config.js'))) {
      conventions.push('Vitest for tests');
    }
    if (await has('tsconfig.json')) conventions.push('TypeScript with shared tsconfig');
    if (await has('.editorconfig')) conventions.push('EditorConfig');

    const nvmrc = await this.tryRead(joinPath(root, '.nvmrc'));
    if (nvmrc !== null) conventions.push(`Node ${nvmrc.trim()}`);

    return conventions;
  }

  private async detectDescription(
    root: string,
    rootProject: ProjectRef | undefined,
    framework: string | undefined,
    languages: string[],
  ): Promise<string> {
    const readme = await this.findReadme(root);
    if (readme !== null) {
      const line = firstProseLine(readme);
      if (line.length > 0) return line;
    }
    const name = rootProject?.name ?? basename(root);
    const stack = framework ?? languages[0] ?? 'project';
    return `${name} — a ${stack} project.`;
  }

  private async findReadme(root: string): Promise<string | null> {
    let entries: Awaited<ReturnType<FilesystemPort['readDir']>>;
    try {
      entries = await this.fs.readDir(root);
    } catch {
      return null;
    }
    const readme = entries.find((e) => e.isFile && /^readme(\.|$)/i.test(e.name));
    if (!readme) return null;
    return this.tryRead(joinPath(root, readme.name));
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

function parseIgnoreFile(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#') && !l.startsWith('!'));
}

function compileIgnore(pattern: string): IgnoreRule {
  let p = pattern;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const leadingSlash = p.startsWith('/');
  if (leadingSlash) p = p.slice(1);
  const anchored = leadingSlash || p.includes('/');

  return { re: new RegExp(`^${globToRegExp(p)}$`), anchored, dirOnly };
}

/** Translate a gitignore-style glob into a regex source string. */
function globToRegExp(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if (/[.+^$(){}|[\]\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return out;
}

function isIgnored(rules: IgnoreRule[], relPath: string, isDir: boolean): boolean {
  const base = basename(relPath);
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    const target = rule.anchored ? relPath : base;
    if (rule.re.test(target)) return true;
  }
  return false;
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function detectNodeFramework(pkg: Record<string, unknown> | null): string | undefined {
  if (!pkg) return undefined;
  const deps = {
    ...(asRecord(pkg.dependencies) ?? {}),
    ...(asRecord(pkg.devDependencies) ?? {}),
  };
  for (const [dep, label] of FRAMEWORKS) {
    if (dep in deps) return label;
  }
  return undefined;
}

/** Extract `name = "..."` from a TOML manifest (first match). */
function tomlName(toml: string): string | undefined {
  const match = toml.match(/^\s*name\s*=\s*["']([^"']+)["']/m);
  return match?.[1];
}

function detectPyFramework(pyproject: string): string | undefined {
  const lower = pyproject.toLowerCase();
  for (const [dep, label] of PY_FRAMEWORKS) {
    if (lower.includes(dep)) return label;
  }
  return undefined;
}

/** Map one dependency name to an auth provider, or undefined. First match wins. */
function matchAuthDep(dep: string): string | undefined {
  for (const [sig, provider] of AUTH_LIBS) {
    const hit = sig.endsWith('/') ? dep.startsWith(sig) : dep === sig || dep.startsWith(`${sig}-`);
    if (hit) return provider;
  }
  return undefined;
}

function detectNodeAuth(pkg: Record<string, unknown> | null): ProjectAuth[] {
  if (!pkg) return [];
  const deps = {
    ...(asRecord(pkg.dependencies) ?? {}),
    ...(asRecord(pkg.devDependencies) ?? {}),
  };
  return collectAuth(Object.keys(deps).map((dep) => [matchAuthDep(dep), dep]));
}

function detectPyAuth(pyproject: string): ProjectAuth[] {
  const lower = pyproject.toLowerCase();
  return collectAuth(
    PY_AUTH_LIBS.map(([dep, provider]) => [lower.includes(dep) ? provider : undefined, dep]),
  );
}

/** Group `[provider, package]` hits into per-provider `ProjectAuth`, dropping misses. */
function collectAuth(hits: ReadonlyArray<readonly [string | undefined, string]>): ProjectAuth[] {
  const byProvider = new Map<string, Set<string>>();
  for (const [provider, pkg] of hits) {
    if (!provider) continue;
    const set = byProvider.get(provider) ?? new Set<string>();
    set.add(pkg);
    byProvider.set(provider, set);
  }
  return [...byProvider.entries()].map(([provider, pkgs]) => ({
    provider,
    packages: [...pkgs].sort(),
  }));
}

/** Aggregate per-project auth into workspace-level findings (provider → packages + projects). */
function aggregateAuth(projects: ProjectRef[]): AuthFinding[] {
  const byProvider = new Map<string, { packages: Set<string>; projects: Set<string> }>();
  for (const p of projects) {
    for (const a of p.auth ?? []) {
      const entry = byProvider.get(a.provider) ?? { packages: new Set(), projects: new Set() };
      for (const pkg of a.packages) entry.packages.add(pkg);
      entry.projects.add(p.name);
      byProvider.set(a.provider, entry);
    }
  }
  return [...byProvider.entries()]
    .map(([provider, e]) => ({
      provider,
      packages: [...e.packages].sort(),
      projects: [...e.projects].sort(),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

/** Map dependency names to mobile E2E tool labels (deduped, first-match order). */
function detectMobileE2e(depNames: string[]): string[] {
  const found: string[] = [];
  for (const [sig, label] of MOBILE_E2E_LIBS) {
    const hit = sig.endsWith('/')
      ? depNames.some((d) => d.startsWith(sig))
      : depNames.some((d) => d === sig || d.startsWith(`${sig}-`));
    if (hit && !found.includes(label)) found.push(label);
  }
  return found;
}

/** Collect per-project mobile targets into workspace-level findings (one per app). */
function aggregateMobile(projects: ProjectRef[]): MobileFinding[] {
  const found: MobileFinding[] = [];
  for (const p of projects) {
    if (p.mobile) found.push({ project: p.name, ...p.mobile });
  }
  return found.sort((a, b) => a.project.localeCompare(b.project));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function firstProseLine(markdown: string): string {
  for (const raw of markdown.split('\n')) {
    const line = raw.trim().replace(/^>\s?/, '').trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) continue;
    if (line.startsWith('![') || line.startsWith('<')) continue;
    return line.length > 200 ? `${line.slice(0, 197)}...` : line;
  }
  return '';
}
