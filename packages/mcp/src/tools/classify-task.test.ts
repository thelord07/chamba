/**
 * classify-task.test.ts — ST-9T
 *
 * Tests para chamba_classify_task tool.
 */

import { FakeHash, FakeParche, MemoryFilesystem } from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createServer } from '../server.js';
import type { Services } from '../services.js';

const silentLogger = pino({ level: 'silent' });

function makeServices(): Services {
  return {
    fs: new MemoryFilesystem({}),
    process: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    clock: { now: () => new Date('2026-11-07T10:00:00Z'), today: () => '2026-11-07' },
    system: {
      resources: () => ({
        totalMemBytes: 16 * 1024 ** 3,
        freeMemBytes: 8 * 1024 ** 3,
        cpus: 8,
        loadAvg1: 0,
      }),
    },
    http: new FakeParche({
      now: () => new Date('2026-11-07T10:00:00Z'),
      today: () => '2026-11-07',
    }),
    hash: new FakeHash(),
    cwd: '/proj',
    homedir: '/home/test',
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
    metricsMutex: new Map(),
    metricsSessionId: 'test-session',
    navReadBodyCount: 0,
    platform: 'linux',
    username: 'testuser',
  };
}

async function connect(services?: Services) {
  const svc = services ?? makeServices();
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer(silentLogger, svc);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.map((c) => c.text).join('\n');
}

interface ClassifyResult {
  route: string;
  reasons: string[];
  signals: string[];
  confidence: string;
  overridable: boolean;
}

function structuredOf(result: unknown): ClassifyResult {
  return (result as { structuredContent: ClassifyResult }).structuredContent;
}

describe('chamba_classify_task tool', () => {
  it('classifies a risky task (authentication)', async () => {
    const { client, server } = await connect();
    const result = await client.callTool({
      name: 'chamba_classify_task',
      arguments: { task: 'Cambiar el flujo de autenticación JWT' },
    });
    const structured = structuredOf(result);
    expect(structured.route).toBe('risky');
    expect(structured.confidence).toBe('high');
    expect(structured.overridable).toBe(false);
    expect(structured.reasons.length).toBeGreaterThan(0);
    expect(structured.reasons.length).toBeLessThanOrEqual(5);
    await server.close();
  });

  it('classifies a trivial task (typo fix)', async () => {
    const { client, server } = await connect();
    const result = await client.callTool({
      name: 'chamba_classify_task',
      arguments: { task: 'Corregir typo en el texto del botón de enviar' },
    });
    const structured = structuredOf(result);
    expect(['trivial', 'small']).toContain(structured.route);
    await server.close();
  });

  it('classifies multi-repo task as substantial', async () => {
    const { client, server } = await connect();
    const result = await client.callTool({
      name: 'chamba_classify_task',
      arguments: {
        task: 'Agregar campo de metadata al modelo de usuario',
        repos: ['frontend', 'backend'],
      },
    });
    const structured = structuredOf(result);
    expect(['substantial', 'risky']).toContain(structured.route);
    await server.close();
  });

  it('announces route in text output', async () => {
    const { client, server } = await connect();
    const result = await client.callTool({
      name: 'chamba_classify_task',
      arguments: { task: 'Fix off-by-one error in list pagination' },
    });
    const text = textOf(result);
    expect(text).toContain('Ruta:');
    expect(text).toContain('--route');
    await server.close();
  });

  it('returns structuredContent with all required fields', async () => {
    const { client, server } = await connect();
    const result = await client.callTool({
      name: 'chamba_classify_task',
      arguments: { task: 'Update the payment processing flow' },
    });
    const structured = structuredOf(result);
    expect(['trivial', 'small', 'substantial', 'risky']).toContain(structured.route);
    expect(['high', 'medium', 'low']).toContain(structured.confidence);
    expect(typeof structured.overridable).toBe('boolean');
    expect(Array.isArray(structured.reasons)).toBe(true);
    expect(Array.isArray(structured.signals)).toBe(true);
    await server.close();
  });

  it('uses planText to influence classification', async () => {
    const { client, server } = await connect();
    const result = await client.callTool({
      name: 'chamba_classify_task',
      arguments: {
        task: 'Update user settings page',
        planText: 'This requires a database migration and schema changes',
      },
    });
    const structured = structuredOf(result);
    expect(structured.route).toBe('risky');
    await server.close();
  });
});
