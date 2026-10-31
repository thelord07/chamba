/**
 * load-skills-examples.test.ts — AC5: verifies the real example skills in
 * `examples/skills/` are well-formed, and that `chamba_load_skills` ranks
 * `knex-postgres-performance` first for "optimize knex query n+1" (AC5).
 *
 * Two test groups:
 *   1. Real files — reads examples/skills/ via NodeFilesystem + collectSkillRefs.
 *   2. MCP integration — seeds a MemoryFilesystem with those contents and calls
 *      the real tool through InMemoryTransport; no real HOME, no real ~/.chamba.
 *
 * Depth from this file to examples/skills/:
 *   ../../../examples/skills/   (packages/mcp/src → packages/mcp → packages → repo root → examples/skills)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NodeFilesystem } from '@chamba/adapters';
import { collectSkillRefs, FakeHash, FakeParche, MemoryFilesystem } from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import type { Services } from './services.js';

const silentLogger = pino({ level: 'silent' });

// ---------------------------------------------------------------------------
// Paths — never hardcode absolute worktree paths
// ---------------------------------------------------------------------------
const SKILLS_DIR = fileURLToPath(new URL('../../../examples/skills/', import.meta.url));

const SKILL_FILES = [
  'knex-postgres-performance.md',
  'nestjs-concurrency.md',
  'react-native-performance.md',
] as const;

function readSkillFile(name: string): string {
  return readFileSync(`${SKILLS_DIR}${name}`, 'utf8');
}

// ---------------------------------------------------------------------------
// Services factory (mirrors doctor.test.ts pattern)
// ---------------------------------------------------------------------------
function makeServices(files: Record<string, string>): Services {
  return {
    fs: new MemoryFilesystem(files),
    process: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    clock: { now: () => new Date('2026-07-05T10:00:00Z'), today: () => '2026-07-05' },
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
    http: new FakeParche({
      now: () => new Date('2026-06-09T00:00:00Z'),
      today: () => '2026-06-09',
    }),
    hash: new FakeHash(),
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
  };
}

async function connect(svc: Services) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer(silentLogger, svc);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

interface LoadSkillsResult {
  skills: Array<{ name: string; body: string }>;
  available: Array<{ name: string }>;
}

function structured(result: unknown): LoadSkillsResult {
  return (result as { structuredContent: LoadSkillsResult }).structuredContent;
}

// ---------------------------------------------------------------------------
// Group 1: real file scan via NodeFilesystem
// ---------------------------------------------------------------------------
describe('examples/skills/ — real file scan', () => {
  it('finds exactly 3 skill refs (README.md is ignored)', async () => {
    const fs = new NodeFilesystem();
    const refs = await collectSkillRefs(fs, [SKILLS_DIR]);
    expect(refs).toHaveLength(3);
  });

  it('names are the three expected skills (sorted)', async () => {
    const fs = new NodeFilesystem();
    const refs = await collectSkillRefs(fs, [SKILLS_DIR]);
    const names = refs.map((r) => r.name).sort();
    expect(names).toEqual([
      'knex-postgres-performance',
      'nestjs-concurrency',
      'react-native-performance',
    ]);
  });

  it('every ref has a non-empty name, description and scope', async () => {
    const fs = new NodeFilesystem();
    const refs = await collectSkillRefs(fs, [SKILLS_DIR]);
    for (const ref of refs) {
      expect(ref.name.length).toBeGreaterThan(0);
      expect(ref.description.length).toBeGreaterThan(0);
      expect(ref.scope?.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Group 2: MCP tool integration — MemoryFilesystem, no real disk or HOME
// ---------------------------------------------------------------------------
describe('chamba_load_skills — examples integration', () => {
  // Seed files: 3 skills + README (README should be ignored by the scanner)
  function seedFiles(): Record<string, string> {
    const files: Record<string, string> = {};
    for (const name of SKILL_FILES) {
      files[`/proj/.chamba/skills/${name}`] = readSkillFile(name);
    }
    files['/proj/.chamba/skills/README.md'] = readFileSync(`${SKILLS_DIR}README.md`, 'utf8');
    return files;
  }

  it('returns knex-postgres-performance first for "optimize knex query n+1"', async () => {
    const { client, server } = await connect(makeServices(seedFiles()));
    const res = await client.callTool({
      name: 'chamba_load_skills',
      arguments: { task: 'optimize knex query n+1' },
    });
    const s = structured(res);
    expect(s.skills[0]?.name).toBe('knex-postgres-performance');
    await server.close();
  });

  it('skills array has length 1 (nestjs-concurrency and react-native-performance score 0)', async () => {
    const { client, server } = await connect(makeServices(seedFiles()));
    const res = await client.callTool({
      name: 'chamba_load_skills',
      arguments: { task: 'optimize knex query n+1' },
    });
    const s = structured(res);
    expect(s.skills).toHaveLength(1);
    const names = s.skills.map((sk) => sk.name);
    expect(names).not.toContain('nestjs-concurrency');
    expect(names).not.toContain('react-native-performance');
    await server.close();
  });

  it('available lists all 3 skills', async () => {
    const { client, server } = await connect(makeServices(seedFiles()));
    const res = await client.callTool({
      name: 'chamba_load_skills',
      arguments: { task: 'optimize knex query n+1' },
    });
    const s = structured(res);
    expect(s.available).toHaveLength(3);
    await server.close();
  });
});
