import { ConfigError, MemoryFilesystem } from '@chamba/core';
import { describe, expect, it } from 'vitest';
import { cmdSet, formatModels, formatShow } from './config-cli.js';
import { ConfigStore } from './config-store.js';

const GLOBAL = '/home/.chamba/config.json';
const PROJECT = '/proj/.chamba/config.json';

describe('formatModels', () => {
  it('lists every catalog model with its provider', () => {
    const out = formatModels();
    expect(out).toContain('claude-opus-4-8');
    expect(out).toContain('gpt-5.5');
    expect(out).toContain('ollama');
  });
});

describe('cmdSet', () => {
  it('validates and merges a single role', async () => {
    const fs = new MemoryFilesystem({});
    const store = new ConfigStore(fs, GLOBAL);
    const msg = await cmdSet(store, {
      role: 'implementer',
      model: 'claude-haiku-4-5',
      effort: 'low',
    });
    expect(msg).toContain('implementer');
    const file = JSON.parse(await fs.readFile(GLOBAL));
    expect(file.overrides.implementer).toEqual({ model: 'claude-haiku-4-5', effort: 'low' });
  });

  it('rejects an unknown role', async () => {
    const store = new ConfigStore(new MemoryFilesystem({}), GLOBAL);
    await expect(
      cmdSet(store, { role: 'wizard', model: 'claude-opus-4-8' }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('rejects an unknown model', async () => {
    const store = new ConfigStore(new MemoryFilesystem({}), GLOBAL);
    await expect(cmdSet(store, { role: 'tester', model: 'gpt-9' })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });
});

describe('formatShow', () => {
  it('reflects a project override and marks the source', async () => {
    const fs = new MemoryFilesystem({
      [PROJECT]: JSON.stringify({
        version: 1,
        overrides: { reviewer: { model: 'claude-sonnet-4-6' } },
      }),
    });
    const out = await formatShow(fs, { globalPath: GLOBAL, projectPath: PROJECT });
    expect(out).toContain('reviewer');
    expect(out).toContain('claude-sonnet-4-6');
    expect(out).toContain('project [applied]');
    expect(out).toContain('global [missing]');
  });

  it('flags an invalid config as ignored', async () => {
    const fs = new MemoryFilesystem({ [GLOBAL]: 'NOT JSON' });
    const out = await formatShow(fs, { globalPath: GLOBAL, projectPath: PROJECT });
    expect(out).toContain('IGNORED');
  });
});
