import { MemoryFilesystem } from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import type { Services } from './services.js';

const silentLogger = pino({ level: 'silent' });

function makeServices(files: Record<string, string> = {}): Services {
  return {
    fs: new MemoryFilesystem(files),
    process: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    clock: { now: () => new Date('2026-06-09T10:00:00Z'), today: () => '2026-06-09' },
    system: {
      resources: () => ({
        totalMemBytes: 16 * 1024 ** 3,
        freeMemBytes: 8 * 1024 ** 3,
        cpus: 8,
        loadAvg1: 0,
      }),
    },
    cwd: '/proj',
    homedir: '/home/test',
  };
}

async function connect(svc: Services) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer(silentLogger, svc);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

describe('chamba_get_agent_config', () => {
  it('returns defaults for every role with no config files', async () => {
    const { client, server } = await connect(makeServices());

    const planner = structured(
      await client.callTool({ name: 'chamba_get_agent_config', arguments: { role: 'planner' } }),
    );
    expect(planner).toMatchObject({
      role: 'planner',
      model: 'claude-opus-4-8',
      effort: 'extreme',
      reasoning_priority: 'thoroughness',
      provider: 'anthropic',
    });
    expect(planner.hint).toContain('maximum effort');

    const summarizer = structured(
      await client.callTool({ name: 'chamba_get_agent_config', arguments: { role: 'summarizer' } }),
    );
    expect(summarizer).toMatchObject({ model: 'claude-haiku-4-5', effort: 'low' });

    await server.close();
  });

  it('reflects a project override', async () => {
    const svc = makeServices({
      '/proj/.chamba/config.json': JSON.stringify({
        version: 1,
        overrides: { reviewer: { model: 'claude-sonnet-4-6' } },
      }),
    });
    const { client, server } = await connect(svc);

    const reviewer = structured(
      await client.callTool({ name: 'chamba_get_agent_config', arguments: { role: 'reviewer' } }),
    );
    expect(reviewer.model).toBe('claude-sonnet-4-6');
    // untouched field keeps the default
    expect(reviewer.effort).toBe('high');

    await server.close();
  });

  it('lets project win over global per field', async () => {
    const svc = makeServices({
      '/home/test/.chamba/config.json': JSON.stringify({
        version: 1,
        overrides: { implementer: { model: 'claude-opus-4-7', effort: 'high' } },
      }),
      '/proj/.chamba/config.json': JSON.stringify({
        version: 1,
        overrides: { implementer: { model: 'gpt-5.5-mini' } },
      }),
    });
    const { client, server } = await connect(svc);

    const impl = structured(
      await client.callTool({
        name: 'chamba_get_agent_config',
        arguments: { role: 'implementer' },
      }),
    );
    expect(impl.model).toBe('gpt-5.5-mini'); // project wins
    expect(impl.effort).toBe('high'); // global field survives
    expect(impl.provider).toBe('openai');

    await server.close();
  });

  it('surfaces a warning and falls back to defaults on a corrupt config', async () => {
    const svc = makeServices({ '/home/test/.chamba/config.json': 'NOT JSON' });
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_get_agent_config',
      arguments: { role: 'orchestrator' },
    });
    const s = structured(result);
    expect(s.model).toBe('claude-opus-4-8');
    expect(s.warning).toContain('Ignored invalid config');

    await server.close();
  });
});
