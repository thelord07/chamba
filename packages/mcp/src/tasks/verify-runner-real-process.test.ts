/**
 * verify-runner-real-process.test.ts — CHAMBA-022
 *
 * Gap test (tester review): every other `verify` test in this package runs
 * against a FAKE `ProcessPort`. This file exercises `chamba_task
 * action='verify'` end to end through the real MCP server with a REAL
 * `NodeProcess` (`@chamba/adapters`) spawning real `node <fixture>.js`
 * scripts under `./fixtures/`, exactly as a user's editor would. It proves,
 * against a genuine OS process (not a double):
 *
 *   - exit 0 and exit 1 are recorded and the per-command evidence is
 *     written to `tareas/<id>/evidencia/<run>/tests-<name>.md`;
 *   - output is capped to the last 200 lines (tailRing) and a
 *     secret-shaped value (built by concatenation, never a literal) is
 *     redacted — the written FILE never contains the raw value;
 *   - O7's env allowlist actually holds against a real child process: a
 *     variable present in the parent (`CHAMBA_TEST_SECRETISH`) does NOT
 *     reach the child by default, and DOES reach it with `inheritEnv: true`.
 *
 * Portable: no shell, no OS-specific syntax — only `node <script>.js`
 * fixtures, exactly like `packages/adapters/src/node-process.test.ts`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeProcess } from '@chamba/adapters';
import { FakeHash, FakeRandom, MemoryFilesystem, type RandomPort } from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from '../server.js';
import type { Services } from '../services.js';

const silentLogger = pino({ level: 'silent' });
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, 'fixtures', name);

/** Value built by concatenation (GitHub push protection; never a literal). */
const LEAK_MARKER = `${'leak'}-${'marker'}-${'value'}`;

async function connect(services: Services) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer(silentLogger, services);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

/** Deterministic run-id generation only needs a monotonic-ish random port. */
function sequentialRandom(): RandomPort {
  return new FakeRandom();
}

describe('chamba_task action=verify — real process end-to-end (CHAMBA-022)', () => {
  let worktreePath: string;
  let repoName: string;

  beforeEach(async () => {
    worktreePath = await mkdtemp(join(tmpdir(), 'chamba-verify-real-'));
    repoName = worktreePath.split(/[\\/]/).pop() as string;
    process.env.CHAMBA_TEST_SECRETISH = LEAK_MARKER;
  });

  afterEach(async () => {
    delete process.env.CHAMBA_TEST_SECRETISH;
    await rm(worktreePath, { recursive: true, force: true });
  });

  function makeRealServices(): Services {
    const wsRoot = dirname(worktreePath);
    const config = JSON.stringify({
      version: 1,
      repos: {
        [repoName]: {
          verify: [
            { name: 'pass', command: 'node', args: [fixture('pass.js')] },
            { name: 'fail', command: 'node', args: [fixture('fail.js')] },
            { name: 'secret', command: 'node', args: [fixture('secret-output.js')] },
            { name: 'envdefault', command: 'node', args: [fixture('env-echo.js')] },
            {
              name: 'envinherit',
              command: 'node',
              args: [fixture('env-echo.js')],
              inheritEnv: true,
            },
          ],
        },
      },
    });

    const files: Record<string, string> = {
      '/vault/.obsidian/app.json': '{}',
      [`${worktreePath}/.git/HEAD`]: 'ref: refs/heads/main\n',
      '/home/test/.chamba/config.json': config,
    };

    return {
      fs: new MemoryFilesystem(files),
      process: new NodeProcess(),
      clock: {
        now: () => new Date('2026-11-13T10:00:00Z'),
        today: () => '2026-11-13',
      },
      system: {
        resources: () => ({
          totalMemBytes: 16 * 1024 ** 3,
          freeMemBytes: 8 * 1024 ** 3,
          cpus: 8,
          loadAvg1: 0,
        }),
      },
      http: {
        request: async () => {
          throw new Error('no network in this test');
        },
      } as Services['http'],
      hash: new FakeHash(),
      random: sequentialRandom(),
      cwd: wsRoot,
      homedir: '/home/test',
      obsidianVaultPath: '/vault',
      parchePullTtlMin: 5,
      vaultMutex: new Map(),
      metricsMutex: new Map(),
      taskMutex: new Map(),
      metricsSessionId: 'test-session',
      navReadBodyCount: 0,
      workspaceRoot: wsRoot,
      platform: process.platform,
      username: 'testuser',
      version: '1.17.0',
    };
  }

  it('exit 0 / exit 1 / 200-line truncation / secret redaction / O7 env allowlist — all against a real child process', async () => {
    const services = makeRealServices();
    const { client } = await connect(services);

    await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'open',
        workItem: 'CHAMBA-200',
        route: 'risky',
        criteria: ['hace X'],
      },
    });

    const res = await client.callTool({
      name: 'chamba_task',
      arguments: {
        action: 'verify',
        workItem: 'CHAMBA-200',
        worktreePath,
        repos: [repoName],
      },
    });

    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as {
      run: { commands: Array<{ name: string; exitCode: number; evidencePath: string }> };
    };
    const byName = new Map(structured.run.commands.map((c) => [c.name, c]));

    // ── exit codes, recorded by the real child process ──────────────────
    expect(byName.get('pass')?.exitCode).toBe(0);
    expect(byName.get('fail')?.exitCode).toBe(1);

    const readEvidence = async (name: string): Promise<string> => {
      const cmd = byName.get(name);
      if (!cmd) throw new Error(`no command named ${name} in the response`);
      return services.fs.readFile(`/vault/${cmd.evidencePath}`);
    };

    const passEvidence = await readEvidence('pass');
    expect(passEvidence).toContain('exit code: 0');

    const failEvidence = await readEvidence('fail');
    expect(failEvidence).toContain('exit code: 1');

    // ── 200-line cap + secret redaction, verified on the WRITTEN FILE ────
    const secretEvidence = await readEvidence('secret');
    expect(secretEvidence).toContain('exit code: 0');
    // N12: `LEAK_MARKER` only ever appears via `envdefault`/`envinherit` below —
    // asserting its absence here was vacuous (it was never present). The
    // meaningful assertion for THIS fixture is the raw secret/truncation
    // checks that follow.
    expect(secretEvidence).not.toContain(`${'AKIA'}${'ABCDEFGHIJKLMNOP'}`); // raw secret, NEVER
    expect(secretEvidence).not.toContain('line-0001'); // oldest lines dropped by the cap
    expect(secretEvidence).toContain('line-0250'); // most recent line survives
    expect(secretEvidence).toMatch(/\[secreto:aws-access-key\]/); // redaction marker present

    // ── O7: allowlist by default, inheritEnv opt-in per command ─────────
    const envDefaultEvidence = await readEvidence('envdefault');
    expect(envDefaultEvidence).toContain('CHAMBA_TEST_SECRETISH=<absent>');
    expect(envDefaultEvidence).not.toContain(LEAK_MARKER);

    const envInheritEvidence = await readEvidence('envinherit');
    expect(envInheritEvidence).toContain(`CHAMBA_TEST_SECRETISH=${LEAK_MARKER}`);
  }, 20_000);
});
