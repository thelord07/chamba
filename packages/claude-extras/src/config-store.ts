import type {
  AgentConfig,
  AgentRole,
  ConfigFile,
  FilesystemPort,
  PartialWorktreeConfig,
  PresetName,
} from '@chamba/core';
import {
  ConfigError,
  DEFAULT_CONFIG,
  dirname,
  mergeWorktreePartial,
  PRESETS,
  parseChambaConfig,
} from '@chamba/core';

/**
 * Reads and writes a single chamba config file (the global `~/.chamba/config.json`).
 * Pure over a `FilesystemPort` so it's testable with an in-memory filesystem.
 */
export class ConfigStore {
  constructor(
    private readonly fs: FilesystemPort,
    private readonly path: string,
  ) {}

  /** The current file, or an empty `{ version: 1 }` if it doesn't exist. */
  async read(): Promise<ConfigFile> {
    if (!(await this.fs.exists(this.path))) return { version: 1 };
    let raw: unknown;
    try {
      raw = JSON.parse(await this.fs.readFile(this.path));
    } catch (e) {
      throw new ConfigError(`invalid JSON in ${this.path}: ${(e as Error).message}`);
    }
    const parsed = parseChambaConfig(raw);
    if (!parsed.ok) throw new ConfigError(`invalid config in ${this.path}: ${parsed.error}`);
    return parsed.value;
  }

  async write(config: ConfigFile): Promise<void> {
    await this.fs.mkdir(dirname(this.path));
    await this.fs.writeFile(this.path, `${JSON.stringify(config, null, 2)}\n`);
  }

  /** Merge a single role's patch into `overrides` and persist (validated). */
  async setRole(role: AgentRole, patch: Partial<AgentConfig>): Promise<ConfigFile> {
    const current = await this.read();
    const overrides = { ...(current.overrides ?? {}) };
    overrides[role] = { ...(overrides[role] ?? {}), ...patch };
    const next: ConfigFile = { ...current, version: 1, overrides };

    const parsed = parseChambaConfig(next);
    if (!parsed.ok) throw new ConfigError(parsed.error);
    await this.write(parsed.value);
    return parsed.value;
  }

  /** Merge a patch into the `worktrees` block and persist (validated). */
  async setWorktrees(patch: PartialWorktreeConfig): Promise<ConfigFile> {
    const current = await this.read();
    const next: ConfigFile = {
      ...current,
      version: 1,
      worktrees: mergeWorktreePartial(current.worktrees ?? {}, patch),
    };
    const parsed = parseChambaConfig(next);
    if (!parsed.ok) throw new ConfigError(parsed.error);
    await this.write(parsed.value);
    return parsed.value;
  }

  /**
   * Apply a named preset as the `defaults` block, preserving any per-role
   * `overrides` and the `worktrees` policy (both orthogonal to the model tier).
   * Overrides still layer on top — run `reset` first for a clean slate.
   */
  async setPreset(name: PresetName): Promise<ConfigFile> {
    const current = await this.read();
    const next: ConfigFile = { ...current, version: 1, defaults: PRESETS[name] };
    const parsed = parseChambaConfig(next);
    if (!parsed.ok) throw new ConfigError(parsed.error);
    await this.write(parsed.value);
    return parsed.value;
  }

  /** Write the compiled defaults as the full config. */
  async reset(): Promise<void> {
    await this.write({ version: 1, defaults: DEFAULT_CONFIG.defaults });
  }

  get filePath(): string {
    return this.path;
  }
}
