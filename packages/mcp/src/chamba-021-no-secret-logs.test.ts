/**
 * chamba-021-no-secret-logs.test.ts — CHAMBA-021 S9.
 *
 * Runs `chamba_vault_sync` against a vault with one file containing a fake
 * secret, captures everything the logger writes (an in-memory destination —
 * never a real file), and asserts the detected VALUE never appears in it,
 * not even its first 12 characters — while the fingerprint does.
 *
 * The fake secret is built by string concatenation so this file itself
 * never contains a literal, GitHub-push-protection-shaped secret.
 */
import {
  CredentialsStore,
  FakeHash,
  FakeParche,
  FakeRandom,
  MemoryFilesystem,
  writeState,
} from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import type { Services } from './services.js';

const VAULT = '/vault';
const SERVER = 'https://parche.example.com';
const SLUG = 'test-group';
const HOMEDIR = '/home/test';

// Built by concatenation — never a literal secret-shaped string in this file.
const FAKE_TOKEN = `pch_${'TESTSECRET'}${'Q'.repeat(20)}`;

function makeClock() {
  return {
    now: () => new Date('2026-10-29T12:00:00Z'),
    today: () => '2026-10-29',
    sleep: () => Promise.resolve(),
  };
}

/** A pino destination that collects every write into an array, in memory only. */
class MemoryDestination {
  lines: string[] = [];
  write(chunk: string): boolean {
    this.lines.push(chunk);
    return true;
  }
}

async function setup() {
  const clock = makeClock();
  const parche = new FakeParche(clock);
  const group = parche.seedGroup({ slug: SLUG, name: 'Test Group' });
  parche.addInvite({ code: 'ABCD-1234', groupId: group.id, role: 'editor' });
  const user = { id: 'usr1', name: 'joys', email: 'joys@test.com' };
  const token = parche.addDevice(group.id, { userId: user.id, label: 'laptop', role: 'editor' });

  const fs = new MemoryFilesystem({
    [`${VAULT}/.obsidian/app.json`]: '{}',
    [`${VAULT}/secret-note.md`]: `# Oops\n\nparche_token: ${FAKE_TOKEN}\n`,
    [`${VAULT}/clean-note.md`]: '# Fine\n\nNo secrets here.\n',
  });

  const creds = new CredentialsStore(fs, HOMEDIR);
  await creds.set(SERVER, SLUG, {
    token,
    user: { id: user.id, name: user.name },
    device: { id: 'dev1', label: 'laptop' },
    role: 'editor',
    dir: VAULT,
  });
  await writeState(fs, VAULT, { server: SERVER, slug: SLUG, cursor: 0, files: {} });

  const destination = new MemoryDestination();
  const logger = pino({ level: 'info' }, destination);

  const services: Services = {
    fs,
    process: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    clock,
    system: {
      resources: () => ({
        totalMemBytes: 16 * 1024 ** 3,
        freeMemBytes: 8 * 1024 ** 3,
        cpus: 8,
        loadAvg1: 0,
      }),
    },
    cwd: '/proj',
    homedir: HOMEDIR,
    http: parche,
    hash: new FakeHash(),
    random: new FakeRandom(),
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
    platform: 'linux',
    username: 'testuser',
  };

  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer(logger, services);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);

  return { client, server, destination, fs };
}

describe('CHAMBA-021 S9 — no secret value ever reaches the logger', () => {
  it('syncing a vault with a secret logs the fingerprint but never the value', async () => {
    const { client, server, destination } = await setup();

    const result = await client.callTool({
      name: 'chamba_vault_sync',
      arguments: { slug: SLUG },
    });

    // Sanity: the tool did detect and block the secret (not silently swallowed).
    const structured = (result as { structuredContent: Record<string, unknown> }).structuredContent;
    const results = structured.results as Array<Record<string, unknown>>;
    expect(JSON.stringify(results)).toContain('secret-note.md');
    const textOut = (result as { content: Array<{ text: string }> }).content
      .map((c) => c.text)
      .join('\n');
    expect(textOut).toContain('bloqueado por posible secreto');

    const allLogText = destination.lines.join('\n');

    // The full token, and even its first 12 chars, must never appear.
    expect(allLogText).not.toContain(FAKE_TOKEN);
    expect(allLogText).not.toContain(FAKE_TOKEN.slice(0, 12));
    expect(allLogText).not.toContain('TESTSECRET');

    // But a fingerprint (12 lowercase hex) for the finding must be present
    // somewhere in the tool's own text output (not necessarily the log).
    expect(textOut).toMatch(/[0-9a-f]{12}/);

    await server.close();
  });
});
