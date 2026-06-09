import type { FilesystemPort } from '../ports/filesystem.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { AGENT_ROLES } from './roles.js';
import { type ConfigFile, parseChambaConfig } from './schema.js';
import type { AgentConfig, ResolvedConfig } from './types.js';

/** Raised when a config is invalid and the caller asked to fail hard. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export type ConfigSourceKind = 'default' | 'global' | 'project';

/** Where a layer came from and whether it applied. */
export interface ConfigSource {
  kind: ConfigSourceKind;
  path?: string;
  status: 'applied' | 'missing' | 'invalid';
  error?: string;
}

export interface LoadConfigResult {
  config: ResolvedConfig;
  sources: ConfigSource[];
}

export interface LoadConfigOptions {
  /** Path to `~/.chamba/config.json`. */
  globalPath?: string;
  /** Path to `<cwd>/.chamba/config.json`. */
  projectPath?: string;
}

/**
 * Resolve the effective config by layering DEFAULT_CONFIG ← global ← project,
 * per role and per field. A missing file is skipped; an invalid one (bad JSON
 * or failed schema) is skipped with a recorded warning — loading never throws,
 * so a corrupt config can never take down the MCP server.
 */
export async function loadConfig(
  fs: FilesystemPort,
  opts: LoadConfigOptions = {},
): Promise<LoadConfigResult> {
  const sources: ConfigSource[] = [{ kind: 'default', status: 'applied' }];
  const config = cloneDefaults();

  const layers: Array<{ kind: ConfigSourceKind; path?: string }> = [
    { kind: 'global', path: opts.globalPath },
    { kind: 'project', path: opts.projectPath },
  ];

  for (const layer of layers) {
    if (!layer.path) continue;
    const loaded = await readLayer(fs, layer.path);
    if (loaded.status === 'missing') {
      sources.push({ kind: layer.kind, path: layer.path, status: 'missing' });
      continue;
    }
    if (loaded.status === 'invalid') {
      sources.push({ kind: layer.kind, path: layer.path, status: 'invalid', error: loaded.error });
      continue;
    }
    applyLayer(config, loaded.file);
    sources.push({ kind: layer.kind, path: layer.path, status: 'applied' });
  }

  return { config, sources };
}

function cloneDefaults(): ResolvedConfig {
  const out = {} as ResolvedConfig;
  for (const role of AGENT_ROLES) {
    out[role] = { ...DEFAULT_CONFIG.defaults[role] };
  }
  return out;
}

function applyLayer(config: ResolvedConfig, file: ConfigFile): void {
  for (const part of [file.defaults, file.overrides]) {
    if (!part) continue;
    for (const role of AGENT_ROLES) {
      const patch = part[role];
      if (!patch) continue;
      config[role] = { ...config[role], ...stripUndefined(patch) };
    }
  }
}

function stripUndefined(patch: Partial<AgentConfig>): Partial<AgentConfig> {
  const out: Partial<AgentConfig> = {};
  if (patch.model !== undefined) out.model = patch.model;
  if (patch.effort !== undefined) out.effort = patch.effort;
  if (patch.reasoning_priority !== undefined) out.reasoning_priority = patch.reasoning_priority;
  return out;
}

type ReadLayerResult =
  | { status: 'missing' }
  | { status: 'invalid'; error: string }
  | { status: 'applied'; file: ConfigFile };

async function readLayer(fs: FilesystemPort, path: string): Promise<ReadLayerResult> {
  let text: string;
  try {
    if (!(await fs.exists(path))) return { status: 'missing' };
    text = await fs.readFile(path);
  } catch {
    return { status: 'missing' };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { status: 'invalid', error: `invalid JSON: ${(e as Error).message}` };
  }

  const parsed = parseChambaConfig(raw);
  if (!parsed.ok) return { status: 'invalid', error: parsed.error };
  return { status: 'applied', file: parsed.value };
}
