import { loadConfig } from '../config/loader.js';
import type { FilesystemPort } from '../ports/filesystem.js';
import type { ProcessPort } from '../ports/process.js';
import type { SystemResources } from '../ports/system.js';
import { computeConcurrencyBudget } from '../resources/budget.js';
import { joinPath } from '../util/path.js';
import { ObsidianDetector } from '../workspace/obsidian-detector.js';
import { findGitRoot, vaultGitignoreMissing } from '../workspace/vault-safety.js';
import { WORKSPACE_DIR, WORKSPACE_RELATIVE_PATH } from '../workspace/workspace.js';
import { detectGitRepos } from '../worktree/git-repo-detector.js';

/** Outcome of a single health check. `fail` is the only status that is not-healthy. */
export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  /** Short stable id, e.g. `node`, `git-repo`, `vault`. */
  id: string;
  /** Human label shown in the report. */
  name: string;
  status: CheckStatus;
  detail: string;
  /** Actionable next step, shown when the check is not `ok`. */
  hint?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: number;
  warn: number;
  fail: number;
  /** True when no check failed (warnings are allowed). */
  healthy: boolean;
}

export interface DoctorInput {
  fs: FilesystemPort;
  process: ProcessPort;
  /** Workspace root to inspect. */
  cwd: string;
  /** User home, for `~/.chamba/{config.json,logs}` and vault probing. */
  homedir: string;
  /** Explicit vault path (CHAMBA_OBSIDIAN_VAULT_PATH), if set. */
  obsidianVaultPath?: string;
  /** Directories to probe for a vault when no explicit path is set. */
  obsidianSearchRoots?: string[];
  /** Running Node version, e.g. `process.version` ("v22.3.0"). */
  nodeVersion?: string;
  /** Live machine resources; when present, adds a `system` capacity line. */
  resources?: SystemResources;
}

const MIN_NODE_MAJOR = 22;
const CONFIG_FILE = `${WORKSPACE_DIR}/config.json`;

/**
 * Run every environment check and return a structured report. Never throws:
 * a probe that errors becomes a `fail`/`warn` check, so a broken environment
 * is exactly what the doctor is meant to surface — not a crash.
 *
 * Pure over ports (no `node:*`), so the MCP tool, the `chamba-mcp doctor` CLI
 * and tests all share one implementation. No LLM — every verdict is mechanical.
 */
export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  checks.push(checkNode(input.nodeVersion));
  if (input.resources) checks.push(checkSystem(input.resources));
  checks.push(await checkGit(input));
  const repo = await checkGitRepo(input);
  checks.push(repo.check);
  checks.push(await checkWorkspace(input));
  checks.push(await checkConfig(input));
  checks.push(await checkVault(input));
  checks.push(await checkMcpRegistration(input));
  checks.push(await checkLogDir(input));
  // The worktree list only makes sense inside a single repo's work tree, not on
  // a multi-repo container (where each child, not the root, is the git repo).
  if (repo.directWorkTree) checks.push(await checkWorktrees(input));

  const ok = checks.filter((c) => c.status === 'ok').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  const fail = checks.filter((c) => c.status === 'fail').length;
  return { checks, ok, warn, fail, healthy: fail === 0 };
}

function checkNode(version?: string): DoctorCheck {
  const base = { id: 'node', name: 'Node.js' };
  const major = parseNodeMajor(version);
  if (major === null) {
    return {
      ...base,
      status: 'warn',
      detail: `could not read Node version (${version ?? 'unknown'})`,
    };
  }
  if (major < MIN_NODE_MAJOR) {
    return {
      ...base,
      status: 'fail',
      detail: `${version} — chamba needs Node ${MIN_NODE_MAJOR} LTS or newer`,
      hint: `Upgrade to Node ${MIN_NODE_MAJOR}+ (nvm install ${MIN_NODE_MAJOR}).`,
    };
  }
  return { ...base, status: 'ok', detail: `${version} (>= ${MIN_NODE_MAJOR})` };
}

function parseNodeMajor(version?: string): number | null {
  if (!version) return null;
  const m = /v?(\d+)\./.exec(version);
  return m ? Number(m[1]) : null;
}

/** Informational: the machine's capacity and the safe parallel-worker ceiling. */
function checkSystem(resources: SystemResources): DoctorCheck {
  const budget = computeConcurrencyBudget({ resources });
  const workers = budget.recommended === 1 ? 'worker' : 'workers';
  return {
    id: 'system',
    name: 'System',
    status: 'ok',
    detail: `${budget.totalMemGB} GB RAM (${budget.freeMemGB} GB free), ${budget.cpus} cores → up to ${budget.recommended} parallel ${workers}`,
  };
}

async function checkGit(input: DoctorInput): Promise<DoctorCheck> {
  const base = { id: 'git', name: 'git' };
  const res = await tryExec(input.process, 'git', ['--version']);
  if (res && res.exitCode === 0) {
    return { ...base, status: 'ok', detail: res.stdout.trim() || 'installed' };
  }
  return {
    ...base,
    status: 'fail',
    detail: 'git not found on PATH',
    hint: 'Install git — worktree tools need it.',
  };
}

/**
 * The git-repo check plus whether the cwd is itself a work tree (vs a container
 * of repos). `directWorkTree` gates the worktree-list check downstream.
 */
interface GitRepoResult {
  check: DoctorCheck;
  directWorkTree: boolean;
}

async function checkGitRepo(input: DoctorInput): Promise<GitRepoResult> {
  const base = { id: 'git-repo', name: 'Git repo' };
  const res = await tryExec(
    input.process,
    'git',
    ['rev-parse', '--is-inside-work-tree'],
    input.cwd,
  );
  if (res && res.exitCode === 0 && res.stdout.trim() === 'true') {
    return {
      check: { ...base, status: 'ok', detail: `${input.cwd} is a git work tree` },
      directWorkTree: true,
    };
  }

  // Not a work tree itself — but it may be a multi-repo container (each child
  // dir is its own git repo, e.g. a "workspace" folder). That's a valid setup,
  // not a problem: report the repo count instead of a false-positive warning.
  const childRepos = await detectChildRepos(input.fs, input.cwd);
  if (childRepos.length > 0) {
    const preview = childRepos.slice(0, 4).join(', ');
    const more = childRepos.length > 4 ? ', …' : '';
    return {
      check: {
        ...base,
        status: 'ok',
        detail: `multi-repo workspace — ${childRepos.length} git repo${
          childRepos.length === 1 ? '' : 's'
        } (${preview}${more})`,
      },
      directWorkTree: false,
    };
  }

  return {
    check: {
      ...base,
      status: 'warn',
      detail: `${input.cwd} is not a git repo`,
      hint: 'Worktree tools (create/list/cleanup) are unavailable outside a git repo.',
    },
    directWorkTree: false,
  };
}

async function detectChildRepos(fs: FilesystemPort, cwd: string): Promise<string[]> {
  try {
    return await detectGitRepos(fs, cwd);
  } catch {
    return [];
  }
}

async function checkWorkspace(input: DoctorInput): Promise<DoctorCheck> {
  const base = { id: 'workspace', name: 'Workspace' };
  const path = joinPath(input.cwd, WORKSPACE_RELATIVE_PATH);
  if (await exists(input.fs, path)) {
    return { ...base, status: 'ok', detail: `${WORKSPACE_RELATIVE_PATH} present` };
  }
  return {
    ...base,
    status: 'warn',
    detail: `${WORKSPACE_RELATIVE_PATH} not found`,
    hint: 'Run chamba_workspace_init to scan the project and seed context.',
  };
}

async function checkConfig(input: DoctorInput): Promise<DoctorCheck> {
  const base = { id: 'config', name: 'Agent config' };
  const globalPath = joinPath(input.homedir, CONFIG_FILE);
  const projectPath = joinPath(input.cwd, CONFIG_FILE);
  const { sources } = await loadConfig(input.fs, { globalPath, projectPath });

  const invalid = sources.find((s) => s.status === 'invalid');
  if (invalid) {
    return {
      ...base,
      status: 'warn',
      detail: `invalid config at ${invalid.path}: ${invalid.error}`,
      hint: 'Fix or delete the file — chamba is falling back to built-in defaults.',
    };
  }
  const applied = sources.filter((s) => s.status === 'applied').map((s) => s.kind);
  const layered = applied.filter((k) => k !== 'default');
  return {
    ...base,
    status: 'ok',
    detail: layered.length > 0 ? `defaults + ${layered.join(' + ')}` : 'built-in defaults',
  };
}

async function checkVault(input: DoctorInput): Promise<DoctorCheck> {
  const base = { id: 'vault', name: 'Obsidian vault' };
  const detection = await new ObsidianDetector(input.fs).detect({
    explicitPath: input.obsidianVaultPath,
    searchRoots: input.obsidianSearchRoots ?? [],
  });
  if (detection.found && detection.path) {
    const source = input.obsidianVaultPath ? 'CHAMBA_OBSIDIAN_VAULT_PATH' : 'autodetected';
    const notes = detection.noteCount ?? 0;
    // A vault inside a git work tree risks committing personal notes/memory — but only
    // warn when its artifacts aren't already gitignored.
    const gitRoot = await findGitRoot(input.fs, detection.path);
    if (gitRoot && (await vaultGitignoreMissing(input.fs, gitRoot)).length > 0) {
      return {
        ...base,
        status: 'warn',
        detail: `${detection.path} is inside a git repo (${gitRoot}) — notes/memory could be committed`,
        hint: 'Move the vault out of the repo (e.g. ~/.chamba/vault) or gitignore its artifacts. workspace_init now bootstraps outside repos and gitignores in-repo vaults.',
      };
    }
    const inRepo = gitRoot ? ', inside a git repo but gitignored' : '';
    return {
      ...base,
      status: 'ok',
      detail: `${detection.path} (${source}, ${notes} notes${inRepo})`,
    };
  }
  return {
    ...base,
    status: 'warn',
    detail: 'no vault connected',
    hint: 'Set CHAMBA_OBSIDIAN_VAULT_PATH, or run chamba_workspace_init to bootstrap one. Memory tools degrade cleanly without it.',
  };
}

/** One chamba registration found in an editor's MCP config. */
interface McpRegistration {
  /** Config file it was found in. */
  source: string;
  /** Launch command, e.g. `npx -y @chamba/mcp` or `chamba-mcp`. */
  command: string;
  /** CHAMBA_OBSIDIAN_VAULT_PATH from its env block, if set. */
  vault?: string;
}

/**
 * Is chamba wired into the editor, and wired **consistently**? Reads the common
 * editor MCP configs and looks for a `chamba` server. The failure this catches is
 * the real footgun: the same server registered in several places (e.g. a global
 * `~/.claude.json` and a project `.mcp.json`) with a *different* launch command or
 * vault env — the editor silently picks one, and it may not be the one you expect.
 * Absence isn't a problem (the doctor can't always see the editor's config), so 0
 * or 1 registration is `ok`; only an inconsistent duplicate warns.
 */
async function checkMcpRegistration(input: DoctorInput): Promise<DoctorCheck> {
  const base = { id: 'mcp', name: 'MCP registration' };
  const candidates: Array<{ path: string; key: 'mcpServers' | 'servers' }> = [
    { path: joinPath(input.homedir, '.claude.json'), key: 'mcpServers' },
    { path: joinPath(input.cwd, '.mcp.json'), key: 'mcpServers' },
    { path: joinPath(input.cwd, '.cursor/mcp.json'), key: 'mcpServers' },
    { path: joinPath(input.homedir, '.cursor/mcp.json'), key: 'mcpServers' },
    { path: joinPath(input.cwd, '.vscode/mcp.json'), key: 'servers' },
  ];

  const regs: McpRegistration[] = [];
  for (const { path, key } of candidates) {
    const found = await readMcpEntry(input.fs, path, key);
    if (found) regs.push({ source: path, ...found });
  }

  if (regs.length === 0) {
    return {
      ...base,
      status: 'ok',
      detail: 'no editor MCP config found here — your editor registers and launches chamba',
    };
  }

  const where = regs.map((r) => shortHome(r.source, input.homedir)).join(', ');
  const commands = new Set(regs.map((r) => r.command));
  const vaults = new Set(regs.map((r) => r.vault ?? '(unset)'));

  if (regs.length > 1 && (commands.size > 1 || vaults.size > 1)) {
    return {
      ...base,
      status: 'warn',
      detail: `registered in ${regs.length} configs with differing setup (${where}) — the editor picks one, and it may not be the one you expect`,
      hint: 'Keep a single chamba entry (prefer the project .mcp.json / .cursor/mcp.json) and remove the duplicate, or make them identical — same command and CHAMBA_OBSIDIAN_VAULT_PATH.',
    };
  }

  const first = regs[0];
  const place =
    regs.length === 1
      ? shortHome(first?.source ?? '', input.homedir)
      : `${regs.length} configs (consistent)`;
  const vaultNote = first?.vault ? `, vault ${first.vault}` : '';
  return { ...base, status: 'ok', detail: `${first?.command ?? '?'} — ${place}${vaultNote}` };
}

/** Extract chamba's launch command + vault env from one editor MCP config, or null. */
async function readMcpEntry(
  fs: FilesystemPort,
  path: string,
  key: 'mcpServers' | 'servers',
): Promise<{ command: string; vault?: string } | null> {
  try {
    if (!(await fs.exists(path))) return null;
    const raw = JSON.parse(await fs.readFile(path)) as Record<string, unknown>;
    const servers = raw[key];
    if (typeof servers !== 'object' || servers === null) return null;
    const chamba = (servers as Record<string, unknown>).chamba;
    if (typeof chamba !== 'object' || chamba === null) return null;
    const c = chamba as { command?: unknown; args?: unknown; env?: unknown };
    const cmd = typeof c.command === 'string' ? c.command : '?';
    const args = Array.isArray(c.args)
      ? c.args.filter((a): a is string => typeof a === 'string')
      : [];
    const command = args.length > 0 ? `${cmd} ${args.join(' ')}` : cmd;
    const env =
      typeof c.env === 'object' && c.env !== null ? (c.env as Record<string, unknown>) : {};
    const rawVault = env.CHAMBA_OBSIDIAN_VAULT_PATH;
    return { command, vault: typeof rawVault === 'string' ? rawVault : undefined };
  } catch {
    return null;
  }
}

/** Replace a leading home dir with `~` for compact display. */
function shortHome(path: string, home: string): string {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

async function checkLogDir(input: DoctorInput): Promise<DoctorCheck> {
  const base = { id: 'logs', name: 'Log directory' };
  const dir = joinPath(input.homedir, WORKSPACE_DIR, 'logs');
  try {
    await input.fs.mkdir(dir);
    return { ...base, status: 'ok', detail: `${dir} writable` };
  } catch (e) {
    return {
      ...base,
      status: 'fail',
      detail: `cannot create ${dir}: ${(e as Error).message}`,
      hint: 'The MCP server logs here; without it, stdio debugging is blind. Check permissions.',
    };
  }
}

async function checkWorktrees(input: DoctorInput): Promise<DoctorCheck> {
  const base = { id: 'worktrees', name: 'Worktrees' };
  const res = await tryExec(input.process, 'git', ['worktree', 'list', '--porcelain'], input.cwd);
  if (res?.exitCode !== 0) {
    return { ...base, status: 'ok', detail: 'none' };
  }
  const count = res.stdout.split('\n').filter((l) => l.startsWith('worktree ')).length;
  return { ...base, status: 'ok', detail: count === 1 ? '1 (main only)' : `${count} worktrees` };
}

async function tryExec(
  process: ProcessPort,
  command: string,
  args: string[],
  cwd?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number } | null> {
  try {
    return await process.exec(command, args, cwd ? { cwd } : undefined);
  } catch {
    return null;
  }
}

async function exists(fs: FilesystemPort, path: string): Promise<boolean> {
  try {
    return await fs.exists(path);
  } catch {
    return false;
  }
}

const ICON: Record<CheckStatus, string> = { ok: '✓', warn: '⚠', fail: '✗' };

/** Render a report to a terminal-friendly string with a summary footer. */
export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = ['chamba doctor', ''];
  for (const c of report.checks) {
    lines.push(`${ICON[c.status]} ${c.name} — ${c.detail}`);
    if (c.hint && c.status !== 'ok') lines.push(`  ↳ ${c.hint}`);
  }
  lines.push('');
  lines.push(`${report.ok} ok · ${report.warn} warn · ${report.fail} fail`);
  lines.push(
    report.healthy
      ? report.warn > 0
        ? 'Ready — with warnings above.'
        : 'All good.'
      : 'Not ready — fix the failures above.',
  );
  return lines.join('\n');
}
