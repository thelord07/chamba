import { MemoryFilesystem } from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import type { Services } from './services.js';

const silentLogger = pino({ level: 'silent' });

function services(): Services {
  return {
    fs: new MemoryFilesystem({}),
    process: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    clock: { now: () => new Date('2026-06-09T00:00:00Z'), today: () => '2026-06-09' },
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

async function connect() {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer(silentLogger, services());
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.map((c) => c.text).join('\n');
}

interface Triage {
  present: string[];
  missing: string[];
  questions: string[];
  enoughToStart: boolean;
  score: number;
}

describe('triage_ticket tool', () => {
  it('flags an info-poor ticket as not enough to start, with questions', async () => {
    const { client, server } = await connect();
    const result = await client.callTool({
      name: 'chamba_triage_ticket',
      arguments: { ticket: 'The login page is broken, please fix.' },
    });
    const triage = (result as unknown as { structuredContent: Triage }).structuredContent;
    expect(triage.enoughToStart).toBe(false);
    expect(triage.missing).toContain('reproduction');
    expect(triage.questions.length).toBeGreaterThan(0);
    expect(textOf(result)).toContain('Ask the reporter:');
    await server.close();
  });

  it('marks a complete ticket as enough to start', async () => {
    const { client, server } = await connect();
    const result = await client.callTool({
      name: 'chamba_triage_ticket',
      arguments: {
        ticket:
          'Steps to reproduce: open /checkout, click Pay. Expected: it confirms; actual: it hangs. ' +
          'Environment: production, Chrome, build 1.4. Affected: the payments screen. ' +
          'Acceptance criteria: paying completes. Severity: P1, no workaround.',
      },
    });
    const triage = (result as unknown as { structuredContent: Triage }).structuredContent;
    expect(triage.enoughToStart).toBe(true);
    expect(triage.missing).toEqual([]);
    expect(triage.score).toBe(1);
    await server.close();
  });
});
