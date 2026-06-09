import type { FilesystemPort, ResolvedConfig } from '@chamba/core';
import { joinPath, loadConfig } from '@chamba/core';
import {
  AGENT_ROLE_BY_FILE,
  parseAgentMarkdown,
  renderAgentMarkdown,
} from './agent-frontmatter.js';

/** The Claude Code subdirectory each asset category installs into. */
export const CATEGORIES = [
  { dir: 'commands', label: 'slash commands' },
  { dir: 'agents', label: 'subagents' },
  { dir: 'hooks', label: 'hooks' },
] as const;

export const MCP_SERVER_NAME = 'chamba';
export const MCP_SERVER_ENTRY = { command: 'npx', args: ['-y', '@chamba/mcp'] };

export interface InstallerOptions {
  fs: FilesystemPort;
  /** Directory holding `commands/`, `agents/`, `hooks/` asset files. */
  assetsDir: string;
  /** Target Claude Code config dir (e.g. `~/.claude`). */
  claudeDir: string;
  /** Target Claude Code MCP config file (e.g. `~/.claude.json`). */
  claudeJsonPath: string;
  /** Global chamba config (e.g. `~/.chamba/config.json`); defaults used if absent. */
  globalConfigPath?: string;
}

export interface ApplyResult {
  regenerated: string[];
  unchanged: string[];
}

export interface InstallResult {
  installed: string[];
  skipped: string[];
  counts: Record<string, number>;
  mcpAdded: boolean;
  mcpAlreadyPresent: boolean;
  claudeDetected: boolean;
}

export interface UninstallResult {
  removed: string[];
  mcpRemoved: boolean;
}

export class Installer {
  private cachedConfig?: ResolvedConfig;

  constructor(private readonly opts: InstallerOptions) {}

  /** True if Claude Code seems present (a config dir or file already exists). */
  async detectClaudeCode(): Promise<boolean> {
    return (
      (await this.opts.fs.exists(this.opts.claudeDir)) ||
      (await this.opts.fs.exists(this.opts.claudeJsonPath))
    );
  }

  async install(options: { force?: boolean } = {}): Promise<InstallResult> {
    const claudeDetected = await this.detectClaudeCode();
    const installed: string[] = [];
    const skipped: string[] = [];
    const counts: Record<string, number> = {};

    for (const { dir } of CATEGORIES) {
      const names = await this.assetNames(dir);
      counts[dir] = 0;
      const targetDir = joinPath(this.opts.claudeDir, dir);
      await this.opts.fs.mkdir(targetDir);

      for (const name of names) {
        const target = joinPath(targetDir, name);
        if (!options.force && (await this.opts.fs.exists(target))) {
          skipped.push(`${dir}/${name}`);
          continue;
        }
        const content = await this.materialize(dir, name);
        await this.opts.fs.writeFile(target, content);
        installed.push(`${dir}/${name}`);
        counts[dir] = (counts[dir] ?? 0) + 1;
      }
    }

    const { mcpAdded, mcpAlreadyPresent } = await this.addMcpServer();
    return { installed, skipped, counts, mcpAdded, mcpAlreadyPresent, claudeDetected };
  }

  async uninstall(): Promise<UninstallResult> {
    const removed: string[] = [];
    for (const { dir } of CATEGORIES) {
      const names = await this.assetNames(dir);
      for (const name of names) {
        const target = joinPath(this.opts.claudeDir, dir, name);
        if (await this.opts.fs.exists(target)) {
          await this.opts.fs.remove(target);
          removed.push(`${dir}/${name}`);
        }
      }
    }
    const mcpRemoved = await this.removeMcpServer();
    return { removed, mcpRemoved };
  }

  /**
   * Regenerate the subagent files in `~/.claude/agents/` from the current
   * config. Idempotent: a file whose rendered content is unchanged is left
   * untouched. Only role-mapped subagents are (re)generated.
   */
  async applyConfig(): Promise<ApplyResult> {
    const regenerated: string[] = [];
    const unchanged: string[] = [];
    const targetDir = joinPath(this.opts.claudeDir, 'agents');
    await this.opts.fs.mkdir(targetDir);

    for (const name of await this.assetNames('agents')) {
      if (!AGENT_ROLE_BY_FILE[name]) continue;
      const content = await this.materialize('agents', name);
      const target = joinPath(targetDir, name);
      if ((await this.readIfExists(target)) === content) {
        unchanged.push(`agents/${name}`);
        continue;
      }
      await this.opts.fs.writeFile(target, content);
      regenerated.push(`agents/${name}`);
    }

    return { regenerated, unchanged };
  }

  /** Read an asset and, for role-mapped subagents, inject model + effort. */
  private async materialize(dir: string, name: string): Promise<string> {
    const raw = await this.opts.fs.readFile(joinPath(this.opts.assetsDir, dir, name));
    if (dir !== 'agents') return raw;
    const role = AGENT_ROLE_BY_FILE[name];
    if (!role) return raw;
    const config = await this.resolveConfig();
    return renderAgentMarkdown(parseAgentMarkdown(raw), config[role]);
  }

  private async resolveConfig(): Promise<ResolvedConfig> {
    if (!this.cachedConfig) {
      const { config } = await loadConfig(this.opts.fs, { globalPath: this.opts.globalConfigPath });
      this.cachedConfig = config;
    }
    return this.cachedConfig;
  }

  private async readIfExists(path: string): Promise<string | null> {
    try {
      if (!(await this.opts.fs.exists(path))) return null;
      return await this.opts.fs.readFile(path);
    } catch {
      return null;
    }
  }

  private async assetNames(dir: string): Promise<string[]> {
    try {
      const entries = await this.opts.fs.readDir(joinPath(this.opts.assetsDir, dir));
      return entries
        .filter((e) => e.isFile)
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  private async readClaudeJson(): Promise<Record<string, unknown>> {
    try {
      const text = await this.opts.fs.readFile(this.opts.claudeJsonPath);
      const parsed: unknown = JSON.parse(text);
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private async addMcpServer(): Promise<{ mcpAdded: boolean; mcpAlreadyPresent: boolean }> {
    const config = await this.readClaudeJson();
    const servers = asRecord(config.mcpServers) ?? {};
    if (MCP_SERVER_NAME in servers) {
      return { mcpAdded: false, mcpAlreadyPresent: true };
    }
    servers[MCP_SERVER_NAME] = MCP_SERVER_ENTRY;
    config.mcpServers = servers;
    await this.opts.fs.writeFile(this.opts.claudeJsonPath, `${JSON.stringify(config, null, 2)}\n`);
    return { mcpAdded: true, mcpAlreadyPresent: false };
  }

  private async removeMcpServer(): Promise<boolean> {
    const config = await this.readClaudeJson();
    const servers = asRecord(config.mcpServers);
    if (!servers || !(MCP_SERVER_NAME in servers)) return false;
    delete servers[MCP_SERVER_NAME];
    config.mcpServers = servers;
    await this.opts.fs.writeFile(this.opts.claudeJsonPath, `${JSON.stringify(config, null, 2)}\n`);
    return true;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}
