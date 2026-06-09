import type { FilesystemPort } from '@chamba/core';
import { joinPath } from '@chamba/core';

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
        const content = await this.opts.fs.readFile(joinPath(this.opts.assetsDir, dir, name));
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
