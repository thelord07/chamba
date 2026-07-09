import { MemoryFilesystem } from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import type { Services } from './services.js';

const silentLogger = pino({ level: 'silent' });

function makeServices(): Services {
  return {
    fs: new MemoryFilesystem({}),
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

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.map((c) => c.text).join('\n');
}

describe('memory tools', () => {
  it('remember writes a file and recall finds it', async () => {
    const svc = makeServices();
    const { client, server } = await connect(svc);

    const saved = await client.callTool({
      name: 'chamba_remember',
      arguments: {
        key: 'auth-decisions',
        content: 'We use magic links via Resend',
        tags: ['auth'],
      },
    });
    expect(textOf(saved)).toContain('/proj/.chamba/memory/auth-decisions.md');
    expect(await svc.fs.exists('/proj/.chamba/memory/auth-decisions.md')).toBe(true);

    const recalled = await client.callTool({
      name: 'chamba_recall',
      arguments: { query: 'auth' },
    });
    expect(textOf(recalled)).toContain('magic links via Resend');

    await server.close();
  });

  it('recall reports when nothing matches', async () => {
    const { client, server } = await connect(makeServices());
    const result = await client.callTool({ name: 'chamba_recall', arguments: { query: 'ghost' } });
    expect(textOf(result)).toContain('No memories matched');
    await server.close();
  });
});
