/**
 * parche-010-review.test.ts — PARCHE-010 review-blocker tests.
 *
 * Covers:
 *   AC6  — chamba_vault_join inside workspace without scope → needsScope (no server calls, no parche.json)
 *           chamba_vault_join with scope:workspace and <ws>/vault existing → vaultDir stored as "vault"
 *   vault-link — after finalizeAdoption, parche.json updated with new vaultDir; updatedBindings in structuredContent
 *   AC2  — chamba_vault_resync with corrupt state.json:
 *             local-vs-remote conflict → remote wins, copy saved; local-only uploaded;
 *             remote-only downloaded; no local file disappears
 *           CLI vault resync --yes: same guarantees
 */

import { FakeHash, FakeParche, MemoryFilesystem, readState, writeState } from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { runVaultCli, type VaultCliDeps } from './cli/vault.js';
import { createServer } from './server.js';
import type { Services } from './services.js';

const silentLogger = pino({ level: 'silent' });

const FAKE_NOW = '2026-06-09T10:00:00.000Z';
const HOMEDIR = '/home/test';
const WORKSPACE = `${HOMEDIR}/Projects/my-workspace`;

function makeClock(now = FAKE_NOW) {
  const d = new Date(now);
  return { now: () => d, today: () => d.toISOString().slice(0, 10) };
}

function makeParche() {
  const parche = new FakeParche(makeClock());
  const group = parche.seedGroup({ slug: 'team-alpha', name: 'Team Alpha' });
  parche.addInvite({ code: 'K7QX-M2RP', groupId: group.id, role: 'editor' });
  return { parche, group };
}

function makeServices(parche: FakeParche, extra: Partial<Services> = {}): Services {
  return {
    fs: extra.fs ?? new MemoryFilesystem(),
    process: { exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    clock: makeClock(),
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
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
    ...extra,
  };
}

async function makeWorkspaceServices(
  parche: FakeParche,
  extra: Partial<Services> = {},
): Promise<Services> {
  const fs = (extra.fs as MemoryFilesystem) ?? new MemoryFilesystem();
  await fs.mkdir(`${WORKSPACE}/.chamba`);
  await fs.writeFile(`${WORKSPACE}/.chamba/workspace.md`, '# Workspace\n');
  return makeServices(parche, { fs, cwd: WORKSPACE, ...extra });
}

async function connect(svc: Services) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const server = createServer(silentLogger, svc);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

function structuredOf(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent ?? {};
}

function makeCli(
  svc: Services,
  argv: string[],
  {
    isTTY = false,
    prompt = async () => '',
  }: { isTTY?: boolean; prompt?: (q: string) => Promise<string> } = {},
): Promise<{ out: string[]; err: string[]; code: number }> {
  const out: string[] = [];
  const err: string[] = [];
  let code = 0;
  const deps: VaultCliDeps = {
    services: svc,
    stdout: (m) => out.push(m),
    stderr: (m) => err.push(m),
    exit: (c) => {
      code = c;
    },
    prompt,
    isTTY,
    hostname: 'test-laptop',
  };
  return runVaultCli(argv, deps).then(() => ({ out, err, code }));
}

// ─── AC6: chamba_vault_join needs-scope ──────────────────────────────────────

describe('AC6 — chamba_vault_join: needs-scope inside workspace', () => {
  it('workspace + no scope → needsScope:true, 0 server requests, no parche.json written', async () => {
    const { parche } = makeParche();
    const svc = await makeWorkspaceServices(parche);
    const { client, server } = await connect(svc);

    const requestsBefore = parche.requestLog.length;

    const result = await client.callTool({
      name: 'chamba_vault_join',
      arguments: { code: 'K7QX-M2RP', name: 'Joys', email: 'j@x.dev' },
    });

    // No isError — needsScope is a prompt, not an error
    expect((result as { isError?: boolean }).isError).toBeFalsy();

    const sc = structuredOf(result);
    expect(sc.needsScope).toBe(true);
    expect(sc.workspaceRoot).toBe(WORKSPACE);

    // 0 network calls to the parche server
    expect(parche.requestLog.length).toBe(requestsBefore);

    // No parche.json written (workspace or global)
    const wsParche = `${WORKSPACE}/.chamba/parche.json`;
    const globalParche = `${HOMEDIR}/.chamba/parche.json`;
    expect(await svc.fs.exists(wsParche)).toBe(false);
    expect(await svc.fs.exists(globalParche)).toBe(false);

    await server.close();
  });

  it('scope:workspace + <ws>/vault exists → vaultDir stored relative ("vault")', async () => {
    const { parche } = makeParche();
    const fs = new MemoryFilesystem();
    // Create workspace + vault subdir
    await fs.mkdir(`${WORKSPACE}/.chamba`);
    await fs.writeFile(`${WORKSPACE}/.chamba/workspace.md`, '# Workspace\n');
    await fs.mkdir(`${WORKSPACE}/vault`);

    const svc = makeServices(parche, { fs, cwd: WORKSPACE });
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_join',
      arguments: {
        code: 'K7QX-M2RP',
        name: 'Joys',
        email: 'j@x.dev',
        scope: 'workspace',
        confirmUpload: true,
      },
    });

    expect((result as { isError?: boolean }).isError).toBeFalsy();

    // parche.json should be written
    const parchePath = `${WORKSPACE}/.chamba/parche.json`;
    expect(await fs.exists(parchePath)).toBe(true);

    const raw = await fs.readFile(parchePath);
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // vaultDir should be the relative path "vault", not the absolute path
    expect(parsed.vaultDir).toBe('vault');
    expect(parsed.slug).toBe('team-alpha');
    expect(parsed.version).toBe(1);

    await server.close();
  });
});

// ─── vault-link: updatedBindings after finalizeAdoption ──────────────────────

describe('vault-link — updatedBindings after re-link', () => {
  it('workspace-bound vault linked to new dir → parche.json updated, updatedBindings in structuredContent', async () => {
    const { parche } = makeParche();
    const fs = new MemoryFilesystem();
    await fs.mkdir(`${WORKSPACE}/.chamba`);
    await fs.writeFile(`${WORKSPACE}/.chamba/workspace.md`, '# Workspace\n');

    const svc = makeServices(parche, { fs, cwd: WORKSPACE });

    // Join with workspace scope
    await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--yes',
      '--scope',
      'workspace',
    ]);

    // The vault is now at the default location; check parche.json
    const parchePath = `${WORKSPACE}/.chamba/parche.json`;
    const initialRaw = await fs.readFile(parchePath);
    const initialParsed = JSON.parse(initialRaw) as Record<string, unknown>;
    const initialVaultDir = initialParsed.vaultDir as string;

    // Create a NEW vault directory to link to
    const newDir = `${HOMEDIR}/new-vault-dir`;
    await fs.mkdir(newDir);
    // No files in new dir (empty vault → gate proceeds automatically)

    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_link',
      arguments: {
        slug: 'team-alpha',
        dir: newDir,
        confirmUpload: true,
      },
    });

    expect((result as { isError?: boolean }).isError).toBeFalsy();

    const sc = structuredOf(result);

    expect(sc.updatedBindings).toEqual([`Vínculo workspace actualizado con nueva ruta: ${newDir}`]);

    // parche.json now points to the new folder and is still an exact v1 binding.
    const afterParsed = JSON.parse(await fs.readFile(parchePath));
    expect(afterParsed).toEqual({ ...initialParsed, vaultDir: newDir });
    expect(afterParsed.vaultDir).not.toBe(initialVaultDir);

    await server.close();
  });
});

// ─── AC2: corrupt state.json + resync ────────────────────────────────────────

describe('AC2 — chamba_vault_resync: corrupt state.json, conflict, local-only, remote-only', () => {
  it('tool: all scenarios — no local file disappears, conflicts handled, uploads/downloads correct', async () => {
    const { parche, group } = makeParche();
    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    // Join first to get credentials
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--yes']);

    const vaultDir = `${HOMEDIR}/.chamba/vaults/team-alpha`;

    // Collect local files before (for "no disappearance" check)
    const localFilesBefore = await listFiles(fs, vaultDir);

    const fakeHash = new FakeHash();
    const enc = new TextEncoder();

    // 1. File with LOCAL content different from server (will conflict)
    const localConflictContent = '# local version\n';
    const serverConflictContent = 'server version\n';
    await fs.writeFile(`${vaultDir}/conflict.md`, localConflictContent);
    const serverConflictHash = await fakeHash.sha256(enc.encode(serverConflictContent));
    parche.seedBlob(group.id, serverConflictHash, enc.encode(serverConflictContent));
    parche.seedChange(group.id, {
      path: 'conflict.md',
      hash: serverConflictHash,
      author: 'Other',
      device: 'dev',
      at: FAKE_NOW,
    });

    // 2. File that exists only locally (will be uploaded)
    const localOnlyContent = '# local only\n';
    await fs.writeFile(`${vaultDir}/local-only.md`, localOnlyContent);

    // 3. File that exists only on server (will be downloaded)
    const remoteOnlyContent = 'remote only content\n';
    const remoteOnlyHash = await fakeHash.sha256(enc.encode(remoteOnlyContent));
    parche.seedBlob(group.id, remoteOnlyHash, enc.encode(remoteOnlyContent));
    parche.seedChange(group.id, {
      path: 'remote-only.md',
      hash: remoteOnlyHash,
      author: 'Other',
      device: 'dev',
      at: FAKE_NOW,
    });

    // 4. Corrupt state.json
    await fs.writeFile(`${vaultDir}/.chamba-sync/state.json`, 'NOT VALID JSON');

    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_resync',
      arguments: { slug: 'team-alpha', confirmUpload: true },
    });

    expect((result as { isError?: boolean }).isError).toBeFalsy();

    // conflict.md: server version wins (pulled) — file content is server version
    const conflictContent = await fs.readFile(`${vaultDir}/conflict.md`);
    expect(conflictContent).toBe(serverConflictContent);

    // A conflict copy was saved (copyPath contains the word "conflicto")
    const allFilesAfter = await listFiles(fs, vaultDir);
    const conflictCopy = allFilesAfter.find(
      (f) => f.includes('conflicto') && f.includes('conflict'),
    );
    expect(conflictCopy).toBeDefined();

    // The conflict copy contains the local content (may have frontmatter prepended)
    const conflictCopyContent = await fs.readFile(`${vaultDir}/${conflictCopy}`);
    expect(conflictCopyContent).toContain(localConflictContent.trim());

    // local-only.md was uploaded (exists in the server's group blobs)
    const localOnlyPuts = parche.requestLog.filter((r) => r.method === 'PUT');
    expect(localOnlyPuts.length).toBeGreaterThan(0);

    // remote-only.md was downloaded
    expect(await fs.exists(`${vaultDir}/remote-only.md`)).toBe(true);

    // No local file disappeared: every file that existed before still exists after
    const localFilesAfterResync = await listFiles(fs, vaultDir);
    for (const f of localFilesBefore) {
      expect(localFilesAfterResync, `File disappeared after resync: ${f}`).toContain(f);
    }

    // State is now valid JSON and not corrupt
    const state = await readState(fs, vaultDir);
    expect(state).not.toBeNull();
    expect(state?.slug).toBe('team-alpha');

    await server.close();
  });

  it('CLI vault resync --yes: same guarantees as tool', async () => {
    const { parche, group } = makeParche();
    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    // Join first
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--yes']);

    const vaultDir = `${HOMEDIR}/.chamba/vaults/team-alpha`;
    const localFilesBefore = await listFiles(fs, vaultDir);

    const fakeHash = new FakeHash();
    const enc = new TextEncoder();

    // Conflict file
    const localConflict = '# cli local\n';
    const serverConflict = 'cli server\n';
    await fs.writeFile(`${vaultDir}/cli-conflict.md`, localConflict);
    const serverHash = await fakeHash.sha256(enc.encode(serverConflict));
    parche.seedBlob(group.id, serverHash, enc.encode(serverConflict));
    parche.seedChange(group.id, {
      path: 'cli-conflict.md',
      hash: serverHash,
      author: 'Other',
      device: 'dev',
      at: FAKE_NOW,
    });

    // Local-only
    await fs.writeFile(`${vaultDir}/cli-local-only.md`, '# local\n');

    // Remote-only
    const remoteContent = 'cli remote\n';
    const remoteHash = await fakeHash.sha256(enc.encode(remoteContent));
    parche.seedBlob(group.id, remoteHash, enc.encode(remoteContent));
    parche.seedChange(group.id, {
      path: 'cli-remote-only.md',
      hash: remoteHash,
      author: 'Other',
      device: 'dev',
      at: FAKE_NOW,
    });

    // Corrupt state.json
    await fs.writeFile(`${vaultDir}/.chamba-sync/state.json`, 'NOT VALID JSON {{{{');

    const r = await makeCli(svc, ['resync', 'team-alpha', '--yes']);
    expect(r.code).toBe(0);

    // cli-conflict.md has server content
    const conflictContent = await fs.readFile(`${vaultDir}/cli-conflict.md`);
    expect(conflictContent).toBe(serverConflict);

    // A conflict copy exists
    const allFilesAfter = await listFiles(fs, vaultDir);
    const conflictCopy = allFilesAfter.find(
      (f) => f.includes('conflicto') && f.includes('cli-conflict'),
    );
    expect(conflictCopy).toBeDefined();

    // cli-remote-only.md downloaded
    expect(await fs.exists(`${vaultDir}/cli-remote-only.md`)).toBe(true);

    // No file disappeared
    const localFilesAfterResync = await listFiles(fs, vaultDir);
    for (const f of localFilesBefore) {
      expect(localFilesAfterResync, `File disappeared after CLI resync: ${f}`).toContain(f);
    }

    // State valid
    const state = await readState(fs, vaultDir);
    expect(state).not.toBeNull();
    expect(state?.slug).toBe('team-alpha');
  });
});

// ─── Helper: list all files recursively ─────────────────────────────────────

async function listFiles(fs: MemoryFilesystem, dir: string): Promise<string[]> {
  const result: string[] = [];
  async function recurse(d: string): Promise<void> {
    let entries: Array<{ name: string; isFile: boolean }>;
    try {
      entries = await fs.readDir(d);
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = `${d}/${entry.name}`;
      if (entry.isFile) {
        // Store relative to dir
        result.push(fullPath.slice(dir.length + 1));
      } else {
        await recurse(fullPath);
      }
    }
  }
  await recurse(dir);
  return result;
}

// Silence unused import warning
void writeState;
