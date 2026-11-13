import { describe, expect, it } from 'vitest';
import { parseChambaConfig } from './schema.js';

describe('parseChambaConfig', () => {
  it('accepts a valid full config', () => {
    const result = parseChambaConfig({
      version: 1,
      defaults: {
        implementer: {
          model: 'claude-sonnet-4-6',
          effort: 'medium',
          reasoning_priority: 'balanced',
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts an overrides-only file with a single field', () => {
    const result = parseChambaConfig({
      version: 1,
      overrides: { reviewer: { model: 'claude-sonnet-4-6' } },
    });
    expect(result.ok).toBe(true);
  });

  it('accepts the 5.5 / 5.1 model ids', () => {
    const result = parseChambaConfig({
      version: 1,
      defaults: {
        orchestrator: { model: 'claude-opus-5-5' },
        implementer: { model: 'claude-sonnet-5-5' },
        researcher: { model: 'claude-fable-5-1' },
      },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an unknown model with a helpful message', () => {
    const result = parseChambaConfig({
      version: 1,
      overrides: { reviewer: { model: 'gpt-9-turbo' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("unknown model 'gpt-9-turbo'");
  });

  it('rejects an invalid effort', () => {
    const result = parseChambaConfig({
      version: 1,
      overrides: { tester: { effort: 'ultra' } },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown role', () => {
    const result = parseChambaConfig({
      version: 1,
      overrides: { wizard: { model: 'claude-opus-4-8' } },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a wrong version', () => {
    const result = parseChambaConfig({ version: 2 });
    expect(result.ok).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    const result = parseChambaConfig({ version: 1, foo: true });
    expect(result.ok).toBe(false);
  });
});

describe('parseChambaConfig — repos.<name>.verify (CHAMBA-022)', () => {
  it('accepts a minimal verify command, defaulting args/timeoutSec/inheritEnv', () => {
    const result = parseChambaConfig({
      version: 1,
      repos: { chamba: { verify: [{ name: 'unit', command: 'node' }] } },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const cmd = result.value.repos?.chamba?.verify[0];
    expect(cmd).toMatchObject({
      name: 'unit',
      command: 'node',
      args: [],
      timeoutSec: 600,
      inheritEnv: false,
    });
  });

  it('accepts env (O7 escape hatch) and inheritEnv opt-in', () => {
    const result = parseChambaConfig({
      version: 1,
      repos: {
        chamba: {
          verify: [
            {
              name: 'unit',
              command: 'pnpm',
              args: ['test'],
              env: { DATABASE_URL: 'postgres://x' },
              inheritEnv: true,
            },
          ],
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a `command` with a space (D-4: must be separated into command + args)', () => {
    const result = parseChambaConfig({
      version: 1,
      repos: { chamba: { verify: [{ name: 'unit', command: 'npm test' }] } },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a `command` with a shell metacharacter', () => {
    const result = parseChambaConfig({
      version: 1,
      repos: { chamba: { verify: [{ name: 'unit', command: 'echo;rm' }] } },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an uppercase/invalid `name`', () => {
    const result = parseChambaConfig({
      version: 1,
      repos: { chamba: { verify: [{ name: 'Unit_Test', command: 'node' }] } },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects more than 10 verify commands for one repo', () => {
    const verify = Array.from({ length: 11 }, (_, i) => ({ name: `c${i}`, command: 'node' }));
    const result = parseChambaConfig({ version: 1, repos: { chamba: { verify } } });
    expect(result.ok).toBe(false);
  });

  it('rejects an invalid env var name as an env key', () => {
    const result = parseChambaConfig({
      version: 1,
      repos: {
        chamba: { verify: [{ name: 'unit', command: 'node', env: { 'not valid': 'x' } }] },
      },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects an unknown key inside a verify command (strict)', () => {
    const result = parseChambaConfig({
      version: 1,
      repos: { chamba: { verify: [{ name: 'unit', command: 'node', shell: true }] } },
    });
    expect(result.ok).toBe(false);
  });
});
