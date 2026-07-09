import { MemoryFilesystem } from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import type { Services } from './services.js';

const silentLogger = pino({ level: 'silent' });

const projectFiles = {
  '/proj/package.json': JSON.stringify({ name: 'proj', dependencies: { express: '^4' } }),
  '/proj/src/index.ts': 'export {};\n',
};

function services(): Services {
  return {
    fs: new MemoryFilesystem(projectFiles),
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

interface Review {
  approved: boolean;
  issues: Array<{ code: string; severity: string; message: string }>;
  suggestions: string[];
  riskFlags: string[];
}

describe('plan tools', () => {
  it('generate_plan returns a template with all sections', async () => {
    const { client, server } = await connect();
    const result = await client.callTool({
      name: 'chamba_generate_plan',
      arguments: { task: 'add a health check endpoint' },
    });
    const text = textOf(result);
    expect(text).toContain('## Acceptance criteria');
    expect(text).toContain('## Subtasks');
    await server.close();
  });

  it('review_plan rejects a plan with no tests', async () => {
    const { client, server } = await connect();
    const result = await client.callTool({
      name: 'chamba_review_plan',
      arguments: {
        task: 'add health check',
        plan: `## Acceptance criteria
- [ ] GET /health returns 200

## Subtasks
1. **implementer** — add src/health.ts`,
      },
    });
    const review = (result as unknown as { structuredContent: Review }).structuredContent;
    expect(review.approved).toBe(false);
    expect(review.issues.map((i) => i.code)).toContain('no-tests');
    await server.close();
  });

  it('review_plan approves a complete plan', async () => {
    const { client, server } = await connect();
    const result = await client.callTool({
      name: 'chamba_review_plan',
      arguments: {
        task: 'add health check',
        plan: `## Acceptance criteria
- [ ] GET /health returns 200
- [ ] Tests cover it

## Subtasks
1. **implementer** — add the route in src/health.ts
2. **tester** — add a vitest test in src/health.test.ts

## Risks
- none identified`,
      },
    });
    const review = (result as unknown as { structuredContent: Review }).structuredContent;
    expect(review.approved).toBe(true);
    await server.close();
  });
});
