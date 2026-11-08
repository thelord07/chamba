/**
 * chamba-021-real-version.test.ts — CHAMBA-021 wave C verification.
 *
 * `createNodeServices()` must resolve a real semver `version` (from
 * `readPackageVersion()`), not the `'unknown'` fallback some test fixtures use
 * when they build a `Services` object by hand without a `version` field. This
 * matters because the provenance stamp on every chamba write is
 * `agent: chamba/<tool>@<version>` — a real write must never end up as
 * `chamba/remember@unknown`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from './server.js';
import { createNodeServices } from './services.js';

const silentLogger = pino({ level: 'silent' });
const SEMVER_RE = /^\d+\.\d+\.\d+/;

describe('createNodeServices resolves a real version', () => {
  it('services.version matches a semver (never undefined, never "unknown")', () => {
    const services = createNodeServices();
    expect(services.version).toBeDefined();
    expect(services.version).toMatch(SEMVER_RE);
    expect(services.version).not.toBe('unknown');
  });

  describe('a real write stamps agent with the real version', () => {
    let tempRoot: string;

    beforeEach(async () => {
      tempRoot = await mkdtemp(join(tmpdir(), 'chamba-021-version-'));
    });

    afterEach(async () => {
      await rm(tempRoot, { recursive: true, force: true });
    });

    it('chamba_remember writes agent: chamba/remember@<semver>, not @unknown', async () => {
      const services = createNodeServices();
      services.cwd = tempRoot;
      services.homedir = join(tempRoot, 'home');

      const server = createServer(silentLogger, services);
      const client = new Client({ name: 'test', version: '0.0.0' });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), client.connect(ct)]);

      await client.callTool({
        name: 'chamba_remember',
        arguments: { key: 'chamba-021-version-check', content: 'contenido de prueba' },
      });

      const written = await services.fs.readFile(
        join(tempRoot, '.chamba', 'memory', 'chamba-021-version-check.md'),
      );

      expect(written).toMatch(/agent: chamba\/remember@\d+\.\d+\.\d+/);
      expect(written).not.toContain('@unknown');

      await server.close();
    });
  });
});
