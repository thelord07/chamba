/**
 * task-metrics.test.ts — ST-9T §5.4
 *
 * Tests:
 *  - línea válida (start → end produce una línea correcta en tasks.jsonl)
 *  - concurrencia sin corrupción (Promise.all con 2 tickets)
 *  - gitignore si está en repo
 *  - sin texto libre en ningún campo
 *  - R5: end sin start → isError
 *  - AC3: secuencia small sin planReview ⇒ planReviewRounds === 0
 */

import {
  type ClockPort,
  FakeHash,
  FakeParche,
  FakeRandom,
  MemoryFilesystem,
  parseTaskMetricsJsonl,
} from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createServer } from '../server.js';
import type { Services } from '../services.js';

const silentLogger = pino({ level: 'silent' });

/**
 * Clock that advances `stepMs` on every `now()` call (B9 del plan). Cada
 * handler (`handleStart`/`handleEvent`/`handleEnd`) llama `now()` exactamente
 * una vez, así la secuencia es determinista y se pueden afirmar ms exactos
 * (múltiplos de `stepMs`) en vez de solo `>= 0`.
 */
function advancingClock(startIso: string, stepMs = 1_000): ClockPort {
  let t = Date.parse(startIso);
  return {
    now: () => {
      const d = new Date(t);
      t += stepMs;
      return d;
    },
    today: () => new Date(t).toISOString().slice(0, 10),
  };
}

function makeServices(files?: Record<string, string>, clock?: ClockPort): Services {
  return {
    fs: new MemoryFilesystem(files ?? {}),
    process: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    // El reloj de `http`/FakeParche se mantiene constante por separado — solo
    // `clock` (el que usan los handlers de task-metrics) puede avanzar.
    clock: clock ?? {
      now: () => new Date('2026-11-07T10:00:00Z'),
      today: () => '2026-11-07',
    },
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
    random: new FakeRandom(),
    cwd: '/proj',
    homedir: '/home/test',
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
    metricsMutex: new Map(),
    metricsSessionId: 'test-session-001',
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
  return { client, server, services: svc };
}

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.map((c) => c.text).join('\n');
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

describe('chamba_task_metrics — línea válida', () => {
  it('start → end produces a valid line in tasks.jsonl', async () => {
    const services = makeServices();
    const { client, server } = await connect(services);

    // start
    const startResult = await client.callTool({
      name: 'chamba_task_metrics',
      arguments: {
        action: 'start',
        workItem: 'TEST-001',
        routeSuggested: 'small',
        source: 'ticket',
      },
    });
    expect(isError(startResult)).toBe(false);

    // end
    const endResult = await client.callTool({
      name: 'chamba_task_metrics',
      arguments: {
        action: 'end',
        workItem: 'TEST-001',
        testsPassed: true,
        delivered: true,
        qaResult: 'skipped',
      },
    });
    expect(isError(endResult)).toBe(false);
    expect(textOf(endResult)).toContain('TEST-001');

    // Verify tasks.jsonl exists with valid content
    const jsonlPath = '/proj/.chamba/metrics/tasks.jsonl';
    const raw = await services.fs.readFile(jsonlPath);
    const metrics = parseTaskMetricsJsonl(raw);
    expect(metrics).toHaveLength(1);

    // biome-ignore lint/style/noNonNullAssertion: single metric guaranteed by test flow
    const m = metrics[0]!;
    expect(m.workItem).toBe('TEST-001');
    expect(m.routeSuggested).toBe('small');
    expect(m.routeFinal).toBe('small');
    expect(m.source).toBe('ticket');
    expect(m.delivered).toBe(true);
    expect(m.testsPassed).toBe(true);
    expect(m.qaResult).toBe('skipped');
    expect(m.planReviewRounds).toBe(0);
    expect(m.verifyRounds).toBe(0);
    expect(m.escalations).toBe(0);
    expect(m.overridden).toBe(false);

    await server.close();
  });

  it('records events correctly', async () => {
    const services = makeServices();
    const { client, server } = await connect(services);

    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: {
        action: 'start',
        workItem: 'TEST-002',
        routeSuggested: 'substantial',
        source: 'ticket',
      },
    });

    // event: planReview (2 rounds)
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'event', workItem: 'TEST-002', kind: 'planReview' },
    });
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'event', workItem: 'TEST-002', kind: 'planReview' },
    });

    // event: verify
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'event', workItem: 'TEST-002', kind: 'verify' },
    });

    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'end', workItem: 'TEST-002', testsPassed: true, delivered: true },
    });

    const raw = await services.fs.readFile('/proj/.chamba/metrics/tasks.jsonl');
    const [m] = parseTaskMetricsJsonl(raw);
    expect(m?.planReviewRounds).toBe(2);
    expect(m?.verifyRounds).toBe(1);

    await server.close();
  });

  it('AC3: small route without planReview event → planReviewRounds === 0', async () => {
    const services = makeServices();
    const { client, server } = await connect(services);

    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: {
        action: 'start',
        workItem: 'SMALL-001',
        routeSuggested: 'small',
        source: 'ticket',
      },
    });
    // NO planReview events (small doesn't invoke planner per §3.2)
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: {
        action: 'end',
        workItem: 'SMALL-001',
        testsPassed: true,
        delivered: true,
      },
    });

    const raw = await services.fs.readFile('/proj/.chamba/metrics/tasks.jsonl');
    const [m] = parseTaskMetricsJsonl(raw);
    expect(m?.planReviewRounds).toBe(0);

    await server.close();
  });
});

describe('chamba_task_metrics — R5: end sin start → isError', () => {
  it('end without start returns isError and writes no line', async () => {
    const services = makeServices();
    const { client, server } = await connect(services);

    const result = await client.callTool({
      name: 'chamba_task_metrics',
      arguments: {
        action: 'end',
        workItem: 'GHOST-001',
        testsPassed: false,
        delivered: false,
      },
    });

    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('GHOST-001');

    // No line written
    const jsonlPath = '/proj/.chamba/metrics/tasks.jsonl';
    const exists = await services.fs.exists(jsonlPath);
    if (exists) {
      const raw = await services.fs.readFile(jsonlPath);
      expect(parseTaskMetricsJsonl(raw)).toHaveLength(0);
    }

    await server.close();
  });
});

describe('chamba_task_metrics — validación de workItem', () => {
  it('rejects workItem with prose text (spaces)', async () => {
    const services = makeServices();
    const { client, server } = await connect(services);

    const result = await client.callTool({
      name: 'chamba_task_metrics',
      arguments: {
        action: 'start',
        workItem: 'esto es una descripcion libre del ticket',
        routeSuggested: 'small',
        source: 'ticket',
      },
    });

    expect(isError(result)).toBe(true);

    await server.close();
  });

  it('accepts valid workItem formats', async () => {
    const services = makeServices();
    const { client, server } = await connect(services);

    for (const workItem of ['CHAMBA-020', 'orq-20261107T153010Z', 'T1', 'my-task.1']) {
      const result = await client.callTool({
        name: 'chamba_task_metrics',
        arguments: { action: 'start', workItem, routeSuggested: 'small', source: 'ticket' },
      });
      expect(isError(result), `workItem="${workItem}" should be accepted`).toBe(false);
    }

    await server.close();
  });
});

describe('chamba_task_metrics — concurrencia', () => {
  it('two concurrent tickets do not corrupt tasks.jsonl', async () => {
    const services = makeServices();
    const { client, server } = await connect(services);

    // Start both
    await Promise.all([
      client.callTool({
        name: 'chamba_task_metrics',
        arguments: {
          action: 'start',
          workItem: 'CONC-001',
          routeSuggested: 'small',
          source: 'ticket',
        },
      }),
      client.callTool({
        name: 'chamba_task_metrics',
        arguments: {
          action: 'start',
          workItem: 'CONC-002',
          routeSuggested: 'small',
          source: 'orq',
        },
      }),
    ]);

    // End both concurrently
    await Promise.all([
      client.callTool({
        name: 'chamba_task_metrics',
        arguments: { action: 'end', workItem: 'CONC-001', testsPassed: true, delivered: true },
      }),
      client.callTool({
        name: 'chamba_task_metrics',
        arguments: { action: 'end', workItem: 'CONC-002', testsPassed: true, delivered: false },
      }),
    ]);

    const raw = await services.fs.readFile('/proj/.chamba/metrics/tasks.jsonl');
    const metrics = parseTaskMetricsJsonl(raw);
    expect(metrics).toHaveLength(2);

    const workItems = metrics.map((m) => m.workItem).sort();
    expect(workItems).toEqual(['CONC-001', 'CONC-002']);

    // Each line is a valid JSON object
    for (const m of metrics) {
      expect(typeof m.startedAt).toBe('string');
      expect(typeof m.endedAt).toBe('string');
    }

    await server.close();
  });
});

describe('chamba_task_metrics — gitignore', () => {
  it('adds .chamba/metrics/ to .gitignore when in a git repo', async () => {
    const services = makeServices({
      '/proj/.git/HEAD': 'ref: refs/heads/main\n',
      '/proj/package.json': '{}',
    });
    const { client, server } = await connect(services);

    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: {
        action: 'start',
        workItem: 'GIT-001',
        routeSuggested: 'small',
        source: 'ticket',
      },
    });
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'end', workItem: 'GIT-001', testsPassed: true, delivered: true },
    });

    const gitignore = await services.fs.readFile('/proj/.gitignore');
    expect(gitignore).toContain('.chamba/metrics/');

    await server.close();
  });

  it('does nothing with gitignore when not in a git repo', async () => {
    const services = makeServices({ '/proj/package.json': '{}' });
    const { client, server } = await connect(services);

    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: {
        action: 'start',
        workItem: 'NOGIT-001',
        routeSuggested: 'small',
        source: 'ticket',
      },
    });
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'end', workItem: 'NOGIT-001', testsPassed: true, delivered: true },
    });

    // No gitignore written (no git repo)
    const gitignoreExists = await services.fs.exists('/proj/.gitignore');
    expect(gitignoreExists).toBe(false);

    // But the metric was written
    const raw = await services.fs.readFile('/proj/.chamba/metrics/tasks.jsonl');
    expect(parseTaskMetricsJsonl(raw)).toHaveLength(1);

    await server.close();
  });
});

describe('chamba_task_metrics — source field', () => {
  it('records source: orq correctly', async () => {
    const services = makeServices();
    const { client, server } = await connect(services);

    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: {
        action: 'start',
        workItem: 'orq-20261107T100000Z',
        routeSuggested: 'small',
        source: 'orq',
      },
    });
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: {
        action: 'end',
        workItem: 'orq-20261107T100000Z',
        testsPassed: true,
        delivered: true,
      },
    });

    const raw = await services.fs.readFile('/proj/.chamba/metrics/tasks.jsonl');
    const [m] = parseTaskMetricsJsonl(raw);
    expect(m?.source).toBe('orq');

    await server.close();
  });
});

// ─── CHAMBA-024: phase_start/phase_end, human_wait_*, strict schema ────────

describe('chamba_task_metrics — CHAMBA-024 fases y pausas', () => {
  it('start abre la fase context; phase_start/phase_end producen phases en la línea', async () => {
    const services = makeServices();
    const { client, server } = await connect(services);

    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'start', workItem: 'PH-001', routeSuggested: 'small', source: 'ticket' },
    });
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'event', workItem: 'PH-001', kind: 'phase_start', phase: 'plan' },
    });
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'event', workItem: 'PH-001', kind: 'phase_end', phase: 'plan' },
    });
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'end', workItem: 'PH-001', testsPassed: true, delivered: true },
    });

    const raw = await services.fs.readFile('/proj/.chamba/metrics/tasks.jsonl');
    const [m] = parseTaskMetricsJsonl(raw);
    expect(m?.phases?.context).toBeDefined();
    expect(m?.phases?.plan).toBeDefined();
    expect(m?.phases?.context?.inferred).toBe(true); // cerrada por el phase_start de plan

    await server.close();
  });

  it('kind="phase_start" sin phase → isError con mensaje en español', async () => {
    const services = makeServices();
    const { client, server } = await connect(services);
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'start', workItem: 'PH-002', routeSuggested: 'small', source: 'ticket' },
    });
    const result = await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'event', workItem: 'PH-002', kind: 'phase_start' },
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toContain('phase');
    await server.close();
  });

  it('kind="verify" con phase → isError (R1: colisión phase vs kind=verify)', async () => {
    const services = makeServices();
    const { client, server } = await connect(services);
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'start', workItem: 'PH-003', routeSuggested: 'small', source: 'ticket' },
    });
    const result = await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'event', workItem: 'PH-003', kind: 'verify', phase: 'verify' },
    });
    expect(isError(result)).toBe(true);
    await server.close();
  });

  it('clave desconocida → isError con el texto del SDK en inglés (B1, AC-9)', async () => {
    const services = makeServices();
    const { client, server } = await connect(services);
    const result = await client.callTool({
      name: 'chamba_task_metrics',
      arguments: {
        action: 'start',
        workItem: 'PH-004',
        routeSuggested: 'small',
        source: 'ticket',
        somethingUnknown: 'x',
      },
    });
    expect(isError(result)).toBe(true);
    expect(textOf(result)).toMatch(/Invalid arguments for tool chamba_task_metrics/i);
    await server.close();
  });

  it('event con clave declarada pero ajena a la acción (routeFinal) sigue funcionando (B2)', async () => {
    const services = makeServices();
    const { client, server } = await connect(services);
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'start', workItem: 'PH-005', routeSuggested: 'small', source: 'ticket' },
    });
    const result = await client.callTool({
      name: 'chamba_task_metrics',
      arguments: {
        action: 'event',
        workItem: 'PH-005',
        kind: 'planReview',
        routeFinal: 'substantial',
      },
    });
    expect(isError(result)).toBe(false);
    await server.close();
  });

  it('phase: "verify" y kind: "verify" coexisten (S6)', async () => {
    const services = makeServices();
    const { client, server } = await connect(services);
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: {
        action: 'start',
        workItem: 'PH-006',
        routeSuggested: 'substantial',
        source: 'ticket',
      },
    });
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'event', workItem: 'PH-006', kind: 'verify' },
    });
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'event', workItem: 'PH-006', kind: 'phase_start', phase: 'verify' },
    });
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'event', workItem: 'PH-006', kind: 'phase_end', phase: 'verify' },
    });
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'end', workItem: 'PH-006', testsPassed: true, delivered: true },
    });
    const raw = await services.fs.readFile('/proj/.chamba/metrics/tasks.jsonl');
    const [m] = parseTaskMetricsJsonl(raw);
    expect(m?.verifyRounds).toBe(1);
    expect(m?.phases?.verify).toBeDefined();
    await server.close();
  });

  it('human_wait_start/end: suma a humanWaits de la línea', async () => {
    const services = makeServices();
    const { client, server } = await connect(services);
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'start', workItem: 'PH-007', routeSuggested: 'small', source: 'ticket' },
    });
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: {
        action: 'event',
        workItem: 'PH-007',
        kind: 'human_wait_start',
        reason: 'clarification',
      },
    });
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'event', workItem: 'PH-007', kind: 'human_wait_end' },
    });
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'end', workItem: 'PH-007', testsPassed: true, delivered: true },
    });
    const raw = await services.fs.readFile('/proj/.chamba/metrics/tasks.jsonl');
    const [m] = parseTaskMetricsJsonl(raw);
    expect(m?.humanWaits?.count).toBe(1);
    expect(m?.humanWaits?.byReason.clarification?.count).toBe(1);
    await server.close();
  });

  it('listTools publica phase y reason, y additionalProperties: false', async () => {
    const services = makeServices();
    const { client, server } = await connect(services);
    const { tools } = await client.listTools();
    const tool = tools.find((t) => t.name === 'chamba_task_metrics');
    expect(tool).toBeDefined();
    const schema = tool?.inputSchema as {
      properties?: Record<string, unknown>;
      additionalProperties?: boolean;
    };
    expect(schema.properties?.phase).toBeDefined();
    expect(schema.properties?.reason).toBeDefined();
    expect(schema.additionalProperties).toBe(false);
    await server.close();
  });
});

describe('chamba_task_metrics — CHAMBA-024 advancingClock (ms exactos a nivel tool)', () => {
  it('phase_start/phase_end producen ms exactos (múltiplos de stepMs)', async () => {
    const STEP_MS = 1_000;
    const services = makeServices(undefined, advancingClock('2026-11-07T10:00:00Z', STEP_MS));
    const { client, server } = await connect(services);

    // now() calls: start(1) → opens context @ t=0, t becomes 1000
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: {
        action: 'start',
        workItem: 'CLOCK-001',
        routeSuggested: 'small',
        source: 'ticket',
      },
    });
    // event phase_start plan(2): nowIso = t=1000 → closes context (ms=1000), t becomes 2000
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'event', workItem: 'CLOCK-001', kind: 'phase_start', phase: 'plan' },
    });
    // event phase_end plan(3): nowIso = t=2000 → closes plan (ms=1000), t becomes 3000
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'event', workItem: 'CLOCK-001', kind: 'phase_end', phase: 'plan' },
    });
    // end(4): nowIso = t=3000
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'end', workItem: 'CLOCK-001', testsPassed: true, delivered: true },
    });

    const raw = await services.fs.readFile('/proj/.chamba/metrics/tasks.jsonl');
    const [m] = parseTaskMetricsJsonl(raw);
    expect(m?.phases?.context).toEqual({ ms: STEP_MS, count: 1, inferred: true });
    expect(m?.phases?.plan).toEqual({ ms: STEP_MS, count: 1 });

    await server.close();
  });

  it('human_wait_start/human_wait_end producen ms exactos y quedan en humanWaits + humanWaitMs de la fase activa', async () => {
    const STEP_MS = 2_000;
    const services = makeServices(undefined, advancingClock('2026-11-07T10:00:00Z', STEP_MS));
    const { client, server } = await connect(services);

    // start(1): t=0 → 2000, abre context
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: {
        action: 'start',
        workItem: 'CLOCK-002',
        routeSuggested: 'small',
        source: 'ticket',
      },
    });
    // human_wait_start(2): nowIso=2000 → 4000
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: {
        action: 'event',
        workItem: 'CLOCK-002',
        kind: 'human_wait_start',
        reason: 'clarification',
      },
    });
    // human_wait_end(3): nowIso=4000 → delta = 4000-2000 = 2000 (1 step), t → 6000
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'event', workItem: 'CLOCK-002', kind: 'human_wait_end' },
    });
    // end(4): nowIso=6000 → closes context: delta = 6000-0 = 6000
    await client.callTool({
      name: 'chamba_task_metrics',
      arguments: { action: 'end', workItem: 'CLOCK-002', testsPassed: true, delivered: true },
    });

    const raw = await services.fs.readFile('/proj/.chamba/metrics/tasks.jsonl');
    const [m] = parseTaskMetricsJsonl(raw);
    expect(m?.humanWaits).toEqual({
      count: 1,
      ms: STEP_MS,
      byReason: { clarification: { count: 1, ms: STEP_MS } },
    });
    expect(m?.phases?.context?.humanWaitMs).toBe(STEP_MS);
    expect(m?.phases?.context?.ms).toBe(3 * STEP_MS); // 0 → 6000
    expect(m?.phases?.context?.inferred).toBe(true);

    await server.close();
  });
});
