import type { FilesystemPort, ResolvedConfig } from '@chamba/core';
import { joinPath, loadConfig } from '@chamba/core';
import {
  AGENT_ROLE_BY_FILE,
  parseAsset,
  renderCursorAgent,
  renderCursorCommand,
} from './render.js';

export const MCP_SERVER_NAME = 'chamba';
/** Default launcher: zero-install, resolves @chamba/mcp via npx on every spawn. */
export const MCP_ENTRY = { command: 'npx', args: ['-y', '@chamba/mcp'] };
/** `--global` launcher: the globally-installed `chamba-mcp` binary — no npx per spawn. */
export const MCP_ENTRY_GLOBAL = { command: 'chamba-mcp' };

/** The Cursor subdirectories chamba installs into. */
export const CATEGORIES = ['commands', 'agents'] as const;

export interface CursorInstallerOptions {
  fs: FilesystemPort;
  /** Directory holding the copied `commands/` + `agents/` asset files. */
  assetsDir: string;
  /** Target Cursor config dir (e.g. `~/.cursor`). */
  cursorDir: string;
  /** Global chamba config (`~/.chamba/config.json`) for the per-role model reparto. */
  globalConfigPath?: string;
}

export interface CursorInstallResult {
  installed: string[];
  skipped: string[];
  counts: Record<string, number>;
  mcpAdded: boolean;
  mcpAlreadyPresent: boolean;
}

export interface CursorUninstallResult {
  removed: string[];
  mcpRemoved: boolean;
}

/**
 * Installs chamba's slash commands + subagents into Cursor and registers the
 * chamba MCP server in `~/.cursor/mcp.json`. Translates the shipped Claude-Code
 * assets into Cursor's format (see render.ts). Never overwrites existing files
 * unless `force`, and preserves any other MCP servers in the config.
 */
export class CursorInstaller {
  private cachedConfig?: ResolvedConfig;

  constructor(private readonly opts: CursorInstallerOptions) {}

  async install(options: { force?: boolean; global?: boolean } = {}): Promise<CursorInstallResult> {
    const installed: string[] = [];
    const skipped: string[] = [];
    const counts: Record<string, number> = {};

    for (const category of CATEGORIES) {
      counts[category] = 0;
      const targetDir = joinPath(this.opts.cursorDir, category);
      await this.opts.fs.mkdir(targetDir);
      for (const name of await this.assetNames(category)) {
        const target = joinPath(targetDir, name);
        if (!options.force && (await this.exists(target))) {
          skipped.push(`${category}/${name}`);
          continue;
        }
        await this.opts.fs.writeFile(target, await this.materialize(category, name));
        installed.push(`${category}/${name}`);
        counts[category] = (counts[category] ?? 0) + 1;
      }
    }

    const { mcpAdded, mcpAlreadyPresent } = await this.registerMcp(options.global);
    return { installed, skipped, counts, mcpAdded, mcpAlreadyPresent };
  }

  async uninstall(): Promise<CursorUninstallResult> {
    const removed: string[] = [];
    for (const category of CATEGORIES) {
      for (const name of await this.assetNames(category)) {
        const target = joinPath(this.opts.cursorDir, category, name);
        if (await this.exists(target)) {
          await this.opts.fs.remove(target);
          removed.push(`${category}/${name}`);
        }
      }
    }
    const mcpRemoved = await this.removeMcp();
    return { removed, mcpRemoved };
  }

  /** Render one asset into its Cursor form (command or subagent). */
  private async materialize(category: string, name: string): Promise<string> {
    const raw = await this.opts.fs.readFile(joinPath(this.opts.assetsDir, category, name));
    const parsed = parseAsset(raw);
    if (category === 'commands') return renderCursorCommand(parsed);
    const role = AGENT_ROLE_BY_FILE[name];
    const model = role ? (await this.resolveConfig())[role].model : '';
    return renderCursorAgent(parsed, model);
  }

  private async resolveConfig(): Promise<ResolvedConfig> {
    if (!this.cachedConfig) {
      const { config } = await loadConfig(this.opts.fs, { globalPath: this.opts.globalConfigPath });
      this.cachedConfig = config;
    }
    return this.cachedConfig;
  }

  private async assetNames(category: string): Promise<string[]> {
    try {
      const entries = await this.opts.fs.readDir(joinPath(this.opts.assetsDir, category));
      return entries
        .filter((e) => e.isFile)
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  private async registerMcp(
    global = false,
  ): Promise<{ mcpAdded: boolean; mcpAlreadyPresent: boolean }> {
    const path = this.configPath();
    const config = await this.readJson(path);
    const servers = asRecord(config.mcpServers) ?? {};
    const entry = global ? MCP_ENTRY_GLOBAL : MCP_ENTRY;
    const existing = servers[MCP_SERVER_NAME];

    if (existing !== undefined) {
      // With --global, upgrade a differing entry (e.g. npx → the binary); else leave it.
      if (global && JSON.stringify(existing) !== JSON.stringify(entry)) {
        servers[MCP_SERVER_NAME] = entry;
        config.mcpServers = servers;
        await this.writeJson(path, config);
        return { mcpAdded: true, mcpAlreadyPresent: false };
      }
      return { mcpAdded: false, mcpAlreadyPresent: true };
    }

    servers[MCP_SERVER_NAME] = entry;
    config.mcpServers = servers;
    await this.writeJson(path, config);
    return { mcpAdded: true, mcpAlreadyPresent: false };
  }

  private async removeMcp(): Promise<boolean> {
    const path = this.configPath();
    const config = await this.readJson(path);
    const servers = asRecord(config.mcpServers);
    if (!servers || !(MCP_SERVER_NAME in servers)) return false;
    delete servers[MCP_SERVER_NAME];
    config.mcpServers = servers;
    await this.writeJson(path, config);
    return true;
  }

  private configPath(): string {
    return joinPath(this.opts.cursorDir, 'mcp.json');
  }

  private async readJson(path: string): Promise<Record<string, unknown>> {
    try {
      const parsed: unknown = JSON.parse(await this.opts.fs.readFile(path));
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  private async writeJson(path: string, config: Record<string, unknown>): Promise<void> {
    await this.opts.fs.writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
  }

  private async exists(path: string): Promise<boolean> {
    try {
      return await this.opts.fs.exists(path);
    } catch {
      return false;
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}
