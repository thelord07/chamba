import { ConfigError, MemoryFilesystem } from '@chamba/core';
import { describe, expect, it } from 'vitest';
import { ConfigStore } from './config-store.js';

const PATH = '/home/.chamba/config.json';

describe('ConfigStore', () => {
  it('returns an empty config when the file is missing', async () => {
    const store = new ConfigStore(new MemoryFilesystem({}), PATH);
    expect(await store.read()).toEqual({ version: 1 });
  });

  it('setRole merges into overrides and persists, keeping other roles', async () => {
    const fs = new MemoryFilesystem({});
    const store = new ConfigStore(fs, PATH);

    await store.setRole('implementer', { model: 'claude-haiku-4-5', effort: 'low' });
    await store.setRole('reviewer', { model: 'claude-sonnet-4-6' });

    const file = JSON.parse(await fs.readFile(PATH));
    expect(file.overrides.implementer).toEqual({ model: 'claude-haiku-4-5', effort: 'low' });
    expect(file.overrides.reviewer).toEqual({ model: 'claude-sonnet-4-6' });
  });

  it('setRole rejects an unknown model', async () => {
    const store = new ConfigStore(new MemoryFilesystem({}), PATH);
    await expect(store.setRole('tester', { model: 'bogus-model' })).rejects.toBeInstanceOf(
      ConfigError,
    );
  });

  it('reset writes the compiled defaults', async () => {
    const fs = new MemoryFilesystem({});
    const store = new ConfigStore(fs, PATH);
    await store.reset();
    const file = JSON.parse(await fs.readFile(PATH));
    expect(file.defaults.planner.effort).toBe('extreme');
  });

  it('read throws a ConfigError on corrupt JSON', async () => {
    const store = new ConfigStore(new MemoryFilesystem({ [PATH]: 'NOT JSON' }), PATH);
    await expect(store.read()).rejects.toBeInstanceOf(ConfigError);
  });
});
