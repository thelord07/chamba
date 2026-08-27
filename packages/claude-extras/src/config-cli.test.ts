import { ConfigError, MemoryFilesystem, resolveWorktreeConfig } from '@chamba/core';
import { describe, expect, it } from 'vitest';
import {
  cmdPreset,
  cmdSet,
  formatModels,
  formatPresets,
  formatShow,
  formatWorktrees,
} from './config-cli.js';
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

describe('formatPresets', () => {
  it('lists every preset', () => {
    const out = formatPresets();
    for (const name of ['budget', 'balanced', 'quality', 'fast']) {
      expect(out).toContain(name);
    }
  });
});

describe('cmdPreset', () => {
  it('applies a preset to the defaults block', async () => {
    const fs = new MemoryFilesystem({});
    const store = new ConfigStore(fs, GLOBAL);
    const msg = await cmdPreset(store, 'budget');
    expect(msg).toContain('budget');
    const file = JSON.parse(await fs.readFile(GLOBAL));
    expect(file.defaults.implementer.model).toBe('claude-haiku-4-5');
    expect(file.defaults.planner.model).toBe('claude-sonnet-5');
  });

  it('rejects an unknown preset', async () => {
    const store = new ConfigStore(new MemoryFilesystem({}), GLOBAL);
    await expect(cmdPreset(store, 'turbo')).rejects.toBeInstanceOf(ConfigError);
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

describe('formatWorktrees', () => {
  it('renders the resolved worktree policy with defaults', () => {
    const out = formatWorktrees(resolveWorktreeConfig());
    expect(out).toContain('layout');
    expect(out).toContain('WORKTREES');
    expect(out).toContain('(autodetect)');
    expect(out).toContain('ports');
    expect(out).toContain('failOnOverlap');
  });

  it('shows overridden fields', () => {
    const out = formatWorktrees(
      resolveWorktreeConfig({ branchPrefix: 'ticket/', copyEnvFiles: true }),
    );
    expect(out).toContain('ticket/');
    expect(out).toContain('copyEnvFiles     true');
  });
});
