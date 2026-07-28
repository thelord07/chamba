import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { loadConfig } from './loader.js';

const GLOBAL = '/home/u/.chamba/config.json';
const PROJECT = '/repo/.chamba/config.json';

describe('loadConfig', () => {
  let fs: MemoryFilesystem;

  beforeEach(() => {
    fs = new MemoryFilesystem();
  });

  it('returns compiled defaults when no files exist', async () => {
    const { config, sources } = await loadConfig(fs, { globalPath: GLOBAL, projectPath: PROJECT });
    expect(config.orchestrator.model).toBe('claude-opus-5');
    expect(sources.find((s) => s.kind === 'global')?.status).toBe('missing');
  });

  it('applies a global config over defaults', async () => {
    await fs.writeFile(
      GLOBAL,
      JSON.stringify({ version: 1, defaults: { implementer: { model: 'claude-haiku-4-5' } } }),
    );
    const { config } = await loadConfig(fs, { globalPath: GLOBAL });
    expect(config.implementer.model).toBe('claude-haiku-4-5');
    // untouched field falls back to the compiled default
    expect(config.implementer.effort).toBe('medium');
  });

  it('lets the project override win per field over global', async () => {
    await fs.writeFile(
      GLOBAL,
      JSON.stringify({
        version: 1,
        overrides: { reviewer: { model: 'claude-opus-4-8', effort: 'high' } },
      }),
    );
    await fs.writeFile(
      PROJECT,
      JSON.stringify({ version: 1, overrides: { reviewer: { model: 'claude-sonnet-4-6' } } }),
    );
    const { config } = await loadConfig(fs, { globalPath: GLOBAL, projectPath: PROJECT });
    expect(config.reviewer.model).toBe('claude-sonnet-4-6'); // project wins
    expect(config.reviewer.effort).toBe('high'); // global field survives
  });

  it('degrades to defaults and warns on corrupt JSON', async () => {
    await fs.writeFile(GLOBAL, 'NOT JSON');
    const { config, sources } = await loadConfig(fs, { globalPath: GLOBAL });
    expect(config.orchestrator.model).toBe('claude-opus-5');
    const global = sources.find((s) => s.kind === 'global');
    expect(global?.status).toBe('invalid');
    expect(global?.error).toContain('invalid JSON');
  });

  it('degrades to defaults and warns on schema-invalid config', async () => {
    await fs.writeFile(
      GLOBAL,
      JSON.stringify({ version: 1, overrides: { tester: { model: 'bogus' } } }),
    );
    const { config, sources } = await loadConfig(fs, { globalPath: GLOBAL });
    expect(config.tester.model).toBe('claude-sonnet-5');
    expect(sources.find((s) => s.kind === 'global')?.status).toBe('invalid');
  });
});
