import { describe, expect, it } from 'vitest';
import { reposWithVerifyConfigured, resolveVerifyCommands } from './verify-config.js';

describe('resolveVerifyCommands', () => {
  it('returns [] when no layer configures the repo', () => {
    expect(resolveVerifyCommands([undefined, {}], 'chamba')).toEqual([]);
  });

  it('project layer REPLACES the global layer for the same repo (no per-command merge)', () => {
    const global = {
      repos: {
        chamba: {
          verify: [
            {
              name: 'global-cmd',
              command: 'echo',
              args: [],
              timeoutSec: 600,
              inheritEnv: false,
            },
          ],
        },
      },
    };
    const project = {
      repos: {
        chamba: {
          verify: [
            {
              name: 'project-cmd',
              command: 'node',
              args: ['test.js'],
              timeoutSec: 600,
              inheritEnv: false,
            },
          ],
        },
      },
    };
    const result = resolveVerifyCommands([global, project], 'chamba');
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('project-cmd');
  });

  it('falls back to global when project does not configure the repo', () => {
    const global = {
      repos: {
        chamba: {
          verify: [{ name: 'g', command: 'echo', args: [], timeoutSec: 600, inheritEnv: false }],
        },
      },
    };
    const result = resolveVerifyCommands([global, {}], 'chamba');
    expect(result[0]?.name).toBe('g');
  });
});

describe('reposWithVerifyConfigured', () => {
  it('lists only repos with a non-empty verify array', () => {
    const layer = {
      repos: {
        chamba: {
          verify: [{ name: 'g', command: 'echo', args: [], timeoutSec: 600, inheritEnv: false }],
        },
        other: { verify: [] },
      },
    };
    expect(reposWithVerifyConfigured([layer])).toEqual(['chamba']);
  });
});
