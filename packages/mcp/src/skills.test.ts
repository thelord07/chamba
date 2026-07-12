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
    clock: { now: () => new Date('2026-07-12T10:00:00Z'), today: () => '2026-07-12' },
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

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.map((c) => c.text).join('\n');
}

function structured(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

const KNEX = `---
name: knex-multitenant
description: Multi-tenant Knex queries filter by tenant_id
scope: backend
---
Always filter every query by tenant_id.`;

const REACT = `---
name: react-hooks
description: Custom React hooks conventions
---
Prefix hooks with use.`;

describe('chamba_load_skills', () => {
  it('returns the relevant skill with its body plus the full catalog', async () => {
    const { client, server } = await connect(
      makeServices({
        '/proj/.chamba/skills/knex.md': KNEX,
        '/proj/.chamba/skills/react.md': REACT,
      }),
    );

    const res = await client.callTool({
      name: 'chamba_load_skills',
      arguments: { task: 'add a multi-tenant knex query for invoices' },
    });
    const s = structured(res);
    const skills = s.skills as Array<{ name: string; body: string }>;
    expect(skills.map((x) => x.name)).toEqual(['knex-multitenant']);
    expect(skills[0]?.body).toContain('tenant_id');
    expect((s.available as Array<{ name: string }>).map((x) => x.name).sort()).toEqual([
      'knex-multitenant',
      'react-hooks',
    ]);

    await server.close();
  });

  it('explains how to create skills when none exist', async () => {
    const { client, server } = await connect(makeServices());
    const res = await client.callTool({
      name: 'chamba_load_skills',
      arguments: { task: 'anything' },
    });
    expect(textOf(res)).toContain('.chamba/skills');
    expect(structured(res).skills as unknown[]).toHaveLength(0);
    await server.close();
  });
});
