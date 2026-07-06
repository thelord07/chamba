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

  it('setPreset writes the preset as defaults, preserving overrides', async () => {
    const fs = new MemoryFilesystem({});
    const store = new ConfigStore(fs, PATH);
    await store.setRole('reviewer', { effort: 'low' });
    await store.setPreset('budget');

    const file = JSON.parse(await fs.readFile(PATH));
    expect(file.defaults.implementer.model).toBe('claude-haiku-4-5');
    expect(file.defaults.orchestrator.model).toBe('claude-sonnet-4-6');
    expect(file.overrides.reviewer.effort).toBe('low');
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

  it('setWorktrees merges into the worktrees block, preserving other config', async () => {
    const fs = new MemoryFilesystem({});
    const store = new ConfigStore(fs, PATH);
    await store.setRole('implementer', { model: 'claude-haiku-4-5' });
    await store.setWorktrees({ layout: 'sibling', root: 'WORKTREES' });
    await store.setWorktrees({ copyEnvFiles: true });

    const file = JSON.parse(await fs.readFile(PATH));
    expect(file.worktrees).toMatchObject({
      layout: 'sibling',
      root: 'WORKTREES',
      copyEnvFiles: true,
    });
    expect(file.overrides.implementer.model).toBe('claude-haiku-4-5');
  });

  it('setWorktrees rejects an invalid layout', async () => {
    const store = new ConfigStore(new MemoryFilesystem({}), PATH);
    // @ts-expect-error invalid layout on purpose
    await expect(store.setWorktrees({ layout: 'flat' })).rejects.toBeInstanceOf(ConfigError);
  });
});
