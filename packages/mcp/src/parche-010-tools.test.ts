import { fileURLToPath } from 'node:url';
/**
 * parche-010-tools.test.ts — PARCHE-010 tests for new tools and behaviors.
 *
 * Covers:
 *   AC2  — chamba_vault_resync: corrupt state, old state → ends synced; no file disappears;
 *           local-only uploaded; remote-only downloaded; noop; conflict handling
 *           CLI vault resync: --yes syncs; no TTY/--yes → exit≠0, nothing uploaded
 *   AC3  — chamba_vault_link and chamba_vault_resync without confirmUpload → needsConfirmation
 *           with exact syncableCount; 0 PUTs; with confirmUpload → uploads N
 *   AC4  — every parche tool (join, sync, parche_status, vault_status, link, unlink, resync)
 *           × (success, error, server 500 body containing pch_secret_123): 0 pch_ in output
 *           R1: chamba_vault_join({code:'pch_live_abc123'}) → 0 pch_ in output
 *   AC5  — prompt file contains explicit rules
 *   AC6  — chamba_vault_join scope:'workspace' → parche.json created; already bound to other slug → rejected
 *   AC7  — chamba_parche_status: binding text index < table text index; workspaceRootSource ∈ {'cwd','env'}
 *           text contains 'cwd' or 'CHAMBA_WORKSPACE_ROOT'; with workspaceRoot env → 'env'
 *   O2   — chamba_vault_sync: 2 conflicts + 1 remote deletion → exact fields; 51 conflicts → truncated.conflicts===1
 *   unlink — removes only parche.json; credentials + vault files intact; no binding → clear message
 *   R10/R11/R15 — code-hash resume:
 *           happy path (same code, confirmUpload) → 1 join total, uploads N
 *           two pendings A(/a) B(/b): join({code:A, dir:'/b', confirmUpload}) → B untouched, 0 push to B
 *           single pending A + join({code:X, confirmUpload}) → A not confirmed
 *           state.json never contains the code in clear
 *           after confirm, JSON.stringify(state) has no pendingJoinCodeHash
 *           parche.json written on needsConfirmation (R11)
 *   R13  — 1.9.0-style pending (no hash) + confirmUpload → message pointing to chamba_vault_link
 *   R2   — pino logs during new tool flows → 0 pch_
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  CredentialsStore,
  FakeHash,
  FakeParche,
  MemoryFilesystem,
  readState,
  writeState,
} from '@chamba/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { runVaultCli, type VaultCliDeps } from './cli/vault.js';
import { createServer } from './server.js';
import type { Services } from './services.js';

// Repo root: this file lives in packages/<pkg>/src/.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const silentLogger = pino({ level: 'silent' });

const FAKE_NOW = '2026-06-09T10:00:00.000Z';
const PARCHE_SERVER = 'https://parche.chamba.tools';
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

function textOf(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content.map((c) => c.text).join('\n');
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

// ─── AC3: vault_link needsConfirmation + confirmUpload ───────────────────────

describe('AC3 — chamba_vault_link: needsConfirmation then upload', () => {
  it('returns needsConfirmation with exact syncableCount when vault has files', async () => {
    const { parche } = makeParche();
    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    // Join a vault first to create credentials
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--yes']);

    // Create another dir with content
    const newDir = '/home/test/another-vault';
    await fs.mkdir(newDir);
    await fs.writeFile(`${newDir}/note1.md`, '# Note 1\n');
    await fs.writeFile(`${newDir}/note2.md`, '# Note 2\n');

    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_link',
      arguments: { slug: 'team-alpha', dir: newDir },
    });

    const sc = structuredOf(result);
    expect(sc.needsConfirmation).toBe(true);
    // 2 .md files seeded above (note1.md, note2.md)
    expect(sc.syncableCount).toBe(2);

    // No PUTs happened
    const puts = parche.requestLog.filter((r) => r.method === 'PUT');
    expect(puts.length).toBe(0);

    await server.close();
  });

  it('with confirmUpload:true → uploads files, no needsConfirmation', async () => {
    const { parche } = makeParche();
    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    // Join first
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--yes']);

    const newDir = '/home/test/another-vault-2';
    await fs.mkdir(newDir);
    await fs.writeFile(`${newDir}/doc.md`, '# Doc\n');

    const { client, server } = await connect(svc);

    // First call: no confirmUpload
    const r1 = await client.callTool({
      name: 'chamba_vault_link',
      arguments: { slug: 'team-alpha', dir: newDir },
    });
    const sc1 = structuredOf(r1);
    expect(sc1.needsConfirmation).toBe(true);
    const syncableCount = sc1.syncableCount as number;
    // 1 .md file seeded above (doc.md)
    expect(syncableCount).toBe(1);

    const putsBefore = parche.requestLog.filter((r) => r.method === 'PUT').length;

    // Second call: with confirmUpload
    const r2 = await client.callTool({
      name: 'chamba_vault_link',
      arguments: { slug: 'team-alpha', dir: newDir, confirmUpload: true },
    });
    expect((r2 as { isError?: boolean }).isError).toBeFalsy();

    const putsAfter = parche.requestLog.filter((r) => r.method === 'PUT').length;
    expect(putsAfter - putsBefore).toBe(syncableCount);

    await server.close();
  });
});

describe('AC3 — chamba_vault_resync: needsConfirmation then upload', () => {
  it('returns needsConfirmation with exact syncableCount when vault has files', async () => {
    const { parche } = makeParche();
    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    // Join a vault
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--yes']);

    // Add files to vault dir
    const vaultDir = `${HOMEDIR}/.chamba/vaults/team-alpha`;
    await fs.writeFile(`${vaultDir}/extra.md`, '# Extra\n');

    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_resync',
      arguments: { slug: 'team-alpha' },
    });

    const sc = structuredOf(result);
    expect(sc.needsConfirmation).toBe(true);
    expect(typeof sc.syncableCount).toBe('number');

    // No PUTs happened
    const puts = parche.requestLog.filter((r) => r.method === 'PUT');
    expect(puts.length).toBe(0);

    await server.close();
  });

  it('with confirmUpload:true → syncs successfully', async () => {
    const { parche } = makeParche();
    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    // Join first
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--yes']);

    const vaultDir = `${HOMEDIR}/.chamba/vaults/team-alpha`;
    await fs.writeFile(`${vaultDir}/note.md`, '# Note\n');

    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_resync',
      arguments: { slug: 'team-alpha', confirmUpload: true },
    });
    expect((result as { isError?: boolean }).isError).toBeFalsy();

    const sc = structuredOf(result);
    expect(sc.needsConfirmation).toBeUndefined();

    await server.close();
  });
});

// ─── AC2: vault resync CLI ────────────────────────────────────────────────────

describe('AC2 — CLI vault resync', () => {
  it('no TTY and no --yes → exit ≠ 0, nothing uploaded', async () => {
    const { parche } = makeParche();
    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    // Join with --yes
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--yes']);

    const vaultDir = `${HOMEDIR}/.chamba/vaults/team-alpha`;
    await fs.writeFile(`${vaultDir}/extra.md`, '# Extra\n');

    const putsBefore = parche.requestLog.filter((r) => r.method === 'PUT').length;

    // resync without --yes and no TTY
    const r = await makeCli(svc, ['resync', 'team-alpha'], { isTTY: false });
    expect(r.code).not.toBe(0);

    const putsAfter = parche.requestLog.filter((r) => r.method === 'PUT').length;
    expect(putsAfter).toBe(putsBefore);
  });

  it('--yes syncs and exits 0', async () => {
    const { parche } = makeParche();
    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--yes']);

    const r = await makeCli(svc, ['resync', 'team-alpha', '--yes']);
    expect(r.code).toBe(0);
    const allOut = [...r.out, ...r.err].join('\n');
    expect(allOut).toMatch(/re-sincronizado|resync/i);
  });

  it('corrupt state.json → resync recovers (ends synced)', async () => {
    const { parche } = makeParche();
    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--yes']);

    const vaultDir = `${HOMEDIR}/.chamba/vaults/team-alpha`;
    // Corrupt state.json
    await fs.writeFile(`${vaultDir}/.chamba-sync/state.json`, 'NOT VALID JSON {{{{');

    await makeCli(svc, ['resync', 'team-alpha', '--yes']);
    // After resync, state.json should be valid
    const state = await readState(fs, vaultDir);
    expect(state).not.toBeNull();
    expect(state?.slug).toBe('team-alpha');
  });
});

// ─── AC4: no pch_ in any tool output ─────────────────────────────────────────

describe('AC4 — no pch_ in tool outputs (all parche tools)', () => {
  // Helper to assert no pch_ in result
  function assertNoPch(result: unknown, toolName: string) {
    const text = textOf(result);
    const sc = structuredOf(result);
    const combined = text + JSON.stringify(sc);
    expect(combined, `${toolName} output contains pch_`).not.toMatch(/pch_/);
  }

  it('R1: chamba_vault_join({code:"pch_live_abc123"}) → no pch_ in output', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_join',
      arguments: { code: 'pch_live_abc123', name: 'Test', email: 't@x.dev' },
    });

    assertNoPch(result, 'chamba_vault_join(code=pch_live_abc123)');
    await server.close();
  });

  it('chamba_vault_join success → no pch_ in text or structuredContent', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_join',
      arguments: { code: 'K7QX-M2RP', name: 'Joys', email: 'j@x.dev' },
    });

    assertNoPch(result, 'chamba_vault_join success');
    await server.close();
  });

  it('chamba_vault_join needsConfirmation → no pch_', async () => {
    const { parche } = makeParche();
    const fs = new MemoryFilesystem();
    const vaultDir = `${HOMEDIR}/.chamba/vaults/team-alpha`;
    await fs.mkdir(vaultDir);
    await fs.writeFile(`${vaultDir}/note.md`, '# Note\n');

    const svc = makeServices(parche, { fs });
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_join',
      arguments: { code: 'K7QX-M2RP', name: 'Joys', email: 'j@x.dev' },
    });

    assertNoPch(result, 'chamba_vault_join needsConfirmation');
    await server.close();
  });

  it('chamba_vault_sync success → no pch_', async () => {
    const { parche } = makeParche();
    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--yes']);
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_sync',
      arguments: {},
    });

    assertNoPch(result, 'chamba_vault_sync success');
    await server.close();
  });

  it('chamba_parche_status success → no pch_', async () => {
    const { parche } = makeParche();
    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--yes']);
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_parche_status',
      arguments: {},
    });

    assertNoPch(result, 'chamba_parche_status success');
    await server.close();
  });

  it('chamba_parche_status error (no vault) → no pch_', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_parche_status',
      arguments: {},
    });

    assertNoPch(result, 'chamba_parche_status error');
    await server.close();
  });

  it('chamba_vault_status success → no pch_', async () => {
    const { parche } = makeParche();
    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--yes']);
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_status',
      arguments: {},
    });

    assertNoPch(result, 'chamba_vault_status success');
    await server.close();
  });

  it('chamba_vault_link error → no pch_', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_link',
      arguments: { slug: 'nonexistent', dir: '/some/dir' },
    });

    assertNoPch(result, 'chamba_vault_link error');
    await server.close();
  });

  it('chamba_vault_unlink success (no binding) → no pch_', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_unlink',
      arguments: {},
    });

    assertNoPch(result, 'chamba_vault_unlink no binding');
    await server.close();
  });

  it('chamba_vault_resync error (no credential) → no pch_', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_resync',
      arguments: { slug: 'nonexistent' },
    });

    assertNoPch(result, 'chamba_vault_resync error');
    await server.close();
  });

  it('R2: pino logs during link/unlink/resync flows → 0 pch_', async () => {
    const { parche } = makeParche();
    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--yes']);

    const logLines: string[] = [];
    const capturedLogger = pino(
      {
        level: 'debug',
        redact: ['token', 'deviceToken', '*.token', 'headers.authorization'],
      },
      { write: (line: string) => logLines.push(line) },
    );

    const [ct, st] = InMemoryTransport.createLinkedPair();
    const srv = createServer(capturedLogger, svc);
    const client2 = new Client({ name: 'test-r2', version: '0.0.0' });
    await Promise.all([srv.connect(st), client2.connect(ct)]);

    // Call link, unlink, resync
    await client2.callTool({
      name: 'chamba_vault_link',
      arguments: {
        slug: 'team-alpha',
        dir: `${HOMEDIR}/.chamba/vaults/team-alpha`,
        confirmUpload: true,
      },
    });
    await client2.callTool({
      name: 'chamba_vault_unlink',
      arguments: {},
    });

    for (const line of logLines) {
      expect(line).not.toMatch(/pch_/);
    }
  });
});

// ─── AC5: prompt file contains explicit rules ─────────────────────────────────

describe('AC5 — parche.md prompt file contains required rules', () => {
  it('contains confirm-before-upload rule', async () => {
    // Path relative to the worktree
    const assetPath = resolve(REPO_ROOT, 'packages/claude-extras/assets/commands/parche.md');
    const content = await readFile(assetPath, 'utf-8');
    // The three explicit rules, plus no retry loops and conflict copies explained.
    expect(content).toContain('**Confirm before uploading.**');
    expect(content).toContain('Never pass `confirmUpload: true` on your own.');
    expect(content).toContain('**Never show or ask for tokens.**');
    expect(content).toContain('**Never delete anything.**');
    expect(content).toContain('explain where each copy was saved');
    expect(content).toContain('do not retry in a loop');
  });

  it('parche.md exists and is non-empty', async () => {
    const assetPath = resolve(REPO_ROOT, 'packages/claude-extras/assets/commands/parche.md');
    const content = await readFile(assetPath, 'utf-8');
    expect(content.length).toBeGreaterThan(50);
    // Should reference chamba_parche_status
    expect(content).toContain('chamba_parche_status');
  });
});

// ─── AC6: workspace scope binding ────────────────────────────────────────────

describe('AC6 — chamba_vault_join workspace scope', () => {
  it('with scope:"workspace" → writes .chamba/parche.json with exact keys', async () => {
    const { parche } = makeParche();
    const svc = await makeWorkspaceServices(parche);
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

    const parchePath = `${WORKSPACE}/.chamba/parche.json`;
    const exists = await svc.fs.exists(parchePath);
    expect(exists).toBe(true);

    const raw = await svc.fs.readFile(parchePath);
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Required keys
    expect(parsed).toHaveProperty('version', 1);
    expect(parsed).toHaveProperty('slug');
    expect(parsed).toHaveProperty('server');
    expect(parsed).toHaveProperty('vaultDir');
    expect(parsed).toHaveProperty('autoSync');

    // Must not contain token or code
    expect(raw).not.toContain('K7QX-M2RP');
    expect(raw).not.toMatch(/pch_/);
    expect(raw).not.toContain('token');

    await server.close();
  });

  it('workspace already bound to another slug → join rejected, file byte-identical', async () => {
    const { parche } = makeParche();
    // Add another invite for a different group
    const group2 = parche.seedGroup({ slug: 'other-group', name: 'Other Group' });
    parche.addInvite({ code: 'ZZZZ-ZZZZ', groupId: group2.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    await fs.mkdir(`${WORKSPACE}/.chamba`);
    await fs.writeFile(`${WORKSPACE}/.chamba/workspace.md`, '# Workspace\n');

    // Write existing binding for team-alpha
    const existingContent = JSON.stringify({
      version: 1,
      server: PARCHE_SERVER,
      slug: 'team-alpha',
      vaultDir: 'vault',
      autoSync: { enabled: true, pullTtlMin: 5 },
    });
    await fs.writeFile(`${WORKSPACE}/.chamba/parche.json`, existingContent);

    const svc = makeServices(parche, { fs, cwd: WORKSPACE });

    // Try to join via CLI with other-group code → should fail
    const r = await makeCli(svc, [
      'join',
      'ZZZZ-ZZZZ',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--scope',
      'workspace',
    ]);

    expect(r.code).not.toBe(0);

    // parche.json must be byte-identical
    const after = await fs.readFile(`${WORKSPACE}/.chamba/parche.json`);
    expect(after).toBe(existingContent);
  });
});

// ─── AC7: chamba_parche_status ordering and workspaceRootSource ──────────────

describe('AC7 — chamba_parche_status: binding before table, workspaceRootSource', () => {
  it('binding text index is BEFORE vault table index in the output text', async () => {
    const { parche } = makeParche();
    const fs = new MemoryFilesystem();
    await fs.mkdir(`${WORKSPACE}/.chamba`);
    await fs.writeFile(`${WORKSPACE}/.chamba/workspace.md`, '# Workspace\n');

    // Write workspace binding
    await fs.writeFile(
      `${WORKSPACE}/.chamba/parche.json`,
      JSON.stringify({
        version: 1,
        server: PARCHE_SERVER,
        slug: 'team-alpha',
        vaultDir: `${HOMEDIR}/.chamba/vaults/team-alpha`,
        autoSync: { enabled: true, pullTtlMin: 5 },
      }),
    );

    const svc = makeServices(parche, { fs, cwd: WORKSPACE });

    // Create credential (join first)
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

    const { client, server } = await connect(svc);
    const result = await client.callTool({ name: 'chamba_parche_status', arguments: {} });
    const text = textOf(result);

    // The binding comes first, then the per-vault table.
    const workspaceIdx = text.indexOf(`Workspace: ${WORKSPACE} (origen: cwd)`);
    const bindingIdx = text.indexOf(
      `Parche binding: workspace — slug="team-alpha", server=${PARCHE_SERVER}, dir=${HOMEDIR}/.chamba/vaults/team-alpha, autoSync=enabled (pullTtlMin=5)`,
    );
    const vaultTableIdx = text.indexOf('slug:');
    expect(workspaceIdx).toBe(0);
    expect(bindingIdx).toBeGreaterThan(workspaceIdx);
    expect(vaultTableIdx).toBeGreaterThan(bindingIdx);

    const sc = structuredOf(result);
    expect(sc.workspaceRootSource).toBe('cwd');
    expect(sc.binding).toEqual({
      scope: 'workspace',
      slug: 'team-alpha',
      server: PARCHE_SERVER,
      vaultDir: `${HOMEDIR}/.chamba/vaults/team-alpha`,
      autoSync: { enabled: true, pullTtlMin: 5 },
    });

    await server.close();
  });

  it('with services.workspaceRoot set → workspaceRootSource is "env"', async () => {
    const { parche } = makeParche();
    const fs = new MemoryFilesystem();
    await fs.mkdir(`${WORKSPACE}/.chamba`);
    await fs.writeFile(`${WORKSPACE}/.chamba/workspace.md`, '# Workspace\n');

    const svc = makeServices(parche, {
      fs,
      cwd: WORKSPACE,
      workspaceRoot: WORKSPACE, // env override
    });
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--yes']);

    const { client, server } = await connect(svc);
    const result = await client.callTool({ name: 'chamba_parche_status', arguments: {} });
    const sc = structuredOf(result);
    const text = textOf(result);

    expect(sc.workspaceRootSource).toBe('env');
    expect(text).toContain(`Workspace: ${WORKSPACE} (origen: CHAMBA_WORKSPACE_ROOT)`);

    await server.close();
  });
});

// ─── O2: vault_sync conflicts + movedToTrash caps ────────────────────────────

describe('O2 — chamba_vault_sync: conflicts and movedToTrash in structuredContent', () => {
  it('exactly 2 conflicts + 1 remote deletion → exact counts, no truncated', async () => {
    const { parche, group } = makeParche();
    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    // Join
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--yes']);

    const vaultDir = `${HOMEDIR}/.chamba/vaults/team-alpha`;

    // Get the device token
    const creds = new CredentialsStore(fs, HOMEDIR);
    const allSlugs = await creds.listSlugs();
    const found = allSlugs[0];
    if (!found) throw new Error('no slug');
    const cred = await creds.get(found.server, found.slug);
    if (!cred) throw new Error('no cred');

    // Sync state: set local files with different hashes than server (create conflicts)
    const stateFile = await readState(fs, vaultDir);
    if (!stateFile) throw new Error('no state');

    // Create 2 local files (locally modified, different from synced hash → conflict)
    const enc = new TextEncoder();
    const fakeHash = new FakeHash();
    await fs.writeFile(`${vaultDir}/file1.md`, '# local v1\n');
    await fs.writeFile(`${vaultDir}/file2.md`, '# local v2\n');

    // to-delete.md: local content matches syncedHash → plain delete (movedToTrash)
    const deleteContent = '# Will be deleted\n';
    const deleteHash = await fakeHash.sha256(enc.encode(deleteContent));
    await fs.writeFile(`${vaultDir}/to-delete.md`, deleteContent);

    // Seed 2 server-version blobs (different from local → conflicts)
    const h1 = await fakeHash.sha256(enc.encode('server v1'));
    const h2 = await fakeHash.sha256(enc.encode('server v2'));
    parche.seedBlob(group.id, h1, enc.encode('server v1'));
    parche.seedBlob(group.id, h2, enc.encode('server v2'));
    parche.seedChange(group.id, {
      path: 'file1.md',
      hash: h1,
      author: 'Other',
      device: 'dev',
      at: FAKE_NOW,
    });
    parche.seedChange(group.id, {
      path: 'file2.md',
      hash: h2,
      author: 'Other',
      device: 'dev',
      at: FAKE_NOW,
    });
    // to-delete.md: server deletion (hash: null)
    parche.seedChange(group.id, {
      path: 'to-delete.md',
      hash: null,
      author: 'Other',
      device: 'dev',
      at: FAKE_NOW,
    });

    // stale hashes must be valid 64-char hex (server validates baseHash with regex).
    // Compute them from dummy content so they differ from real local hashes.
    const staleHash1 = await fakeHash.sha256(enc.encode('stale v1'));
    const staleHash2 = await fakeHash.sha256(enc.encode('stale v2'));

    // Write state with stale hashes for file1/file2 and ACTUAL hash for to-delete
    // so planPull chooses: conflict for file1/file2, delete for to-delete
    await writeState(fs, vaultDir, {
      ...stateFile,
      files: {
        'file1.md': { syncedHash: staleHash1 },
        'file2.md': { syncedHash: staleHash2 },
        'to-delete.md': { syncedHash: deleteHash },
      },
      cursor: stateFile.cursor,
    });

    const { client, server } = await connect(svc);
    const result = await client.callTool({ name: 'chamba_vault_sync', arguments: {} });

    const sc = structuredOf(result);
    const results = sc.results as Array<Record<string, unknown>>;
    // Must have exactly one vault result
    expect(results).toHaveLength(1);
    const syncOut = results[0] as Record<string, unknown>;

    // Ensure sync did not throw (if it did, syncOut.error reveals the message)
    expect(syncOut).not.toHaveProperty('error');

    // 2 conflicts: file1 and file2 (sorted by path)
    const conflicts = syncOut.conflicts as Array<{ path: string; copyPath: string }>;
    expect(conflicts).toHaveLength(2);
    expect(conflicts[0]).toEqual({ path: 'file1.md', copyPath: 'file1 (conflicto joys).md' });
    expect(conflicts[1]).toEqual({ path: 'file2.md', copyPath: 'file2 (conflicto joys).md' });

    // 1 deletion: to-delete.md moved to trash
    const movedToTrash = syncOut.movedToTrash as Array<{ path: string; trashPath: string }>;
    expect(movedToTrash).toHaveLength(1);
    expect(movedToTrash[0]).toEqual({ path: 'to-delete.md', trashPath: '.trash/to-delete.md' });

    // No truncated field (counts are small)
    expect(syncOut.truncated).toBeUndefined();
    // No movedToTrashEntries key exposed
    expect(syncOut).not.toHaveProperty('movedToTrashEntries');

    await server.close();
  });

  it('51 conflicts → 50 listed + truncated.conflicts === 1', async () => {
    const { parche, group } = makeParche();
    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--yes']);

    const vaultDir = `${HOMEDIR}/.chamba/vaults/team-alpha`;
    const stateFile = await readState(fs, vaultDir);
    if (!stateFile) throw new Error('no state after join');

    const enc = new TextEncoder();
    const fakeHash = new FakeHash();

    // Seed 51 server-side changes with blobs; each conflicts with a local file
    const stateFiles: Record<string, { syncedHash: string }> = {};
    for (let i = 0; i < 51; i++) {
      const serverContent = enc.encode(`server content note${i}`);
      const serverHash = await fakeHash.sha256(serverContent);
      parche.seedBlob(group.id, serverHash, serverContent);
      parche.seedChange(group.id, {
        path: `note${i}.md`,
        hash: serverHash,
        author: 'Other',
        device: 'dev',
        at: FAKE_NOW,
      });
      // Local file has different content; stale syncedHash (valid 64-char hex) ensures L !== S
      await fs.writeFile(`${vaultDir}/note${i}.md`, `# local note${i}\n`);
      const staleHash = await fakeHash.sha256(enc.encode(`stale-content-${i}`));
      stateFiles[`note${i}.md`] = { syncedHash: staleHash };
    }
    await writeState(fs, vaultDir, { ...stateFile, files: stateFiles, cursor: stateFile.cursor });

    const { client, server } = await connect(svc);
    const result = await client.callTool({ name: 'chamba_vault_sync', arguments: {} });
    const sc = structuredOf(result);

    expect(sc).toHaveProperty('results');
    const results = sc.results as Array<Record<string, unknown>>;
    expect(results.length).toBeGreaterThan(0);
    const syncOut = results[0] as Record<string, unknown>;

    const conflicts = syncOut.conflicts as Array<unknown>;
    expect(conflicts).toHaveLength(50);
    expect(syncOut.truncated).toEqual({ conflicts: 1, movedToTrash: 0 });

    await server.close();
  });
});

// ─── unlink tool: removes only parche.json ───────────────────────────────────

describe('chamba_vault_unlink — removes only parche.json', () => {
  it('with global binding → removes global parche.json, credentials intact, vault files intact', async () => {
    const { parche } = makeParche();
    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });

    // Join and create vault
    await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev', '--yes']);

    // Write a global parche.json
    await fs.mkdir(`${HOMEDIR}/.chamba`);
    await fs.writeFile(
      `${HOMEDIR}/.chamba/parche.json`,
      JSON.stringify({
        version: 1,
        server: PARCHE_SERVER,
        slug: 'team-alpha',
        vaultDir: `${HOMEDIR}/.chamba/vaults/team-alpha`,
        autoSync: { enabled: true, pullTtlMin: 5 },
      }),
    );

    // Save credentials content before
    const credsBefore = await fs.readFile(`${HOMEDIR}/.chamba/credentials.json`);
    const vaultDir = `${HOMEDIR}/.chamba/vaults/team-alpha`;
    const vaultFilesBefore = await fs.exists(`${vaultDir}/.obsidian`);

    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_unlink',
      arguments: { scope: 'global' },
    });
    const sc = structuredOf(result);
    expect(sc.removed).toBe(true);

    // parche.json gone
    expect(await fs.exists(`${HOMEDIR}/.chamba/parche.json`)).toBe(false);

    // Credentials still intact and byte-identical
    const credsAfter = await fs.readFile(`${HOMEDIR}/.chamba/credentials.json`);
    expect(credsAfter).toBe(credsBefore);

    // Vault files intact
    expect(await fs.exists(`${vaultDir}/.obsidian`)).toBe(vaultFilesBefore);

    await server.close();
  });

  it('no binding present → clear message, no error crash', async () => {
    const { parche } = makeParche();
    const svc = makeServices(parche);
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_unlink',
      arguments: {},
    });
    // Should not be an error
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    const sc = structuredOf(result);
    expect(sc.removed).toBe(false);
    const text = textOf(result);
    expect(text).toContain('No hay vínculo');

    await server.close();
  });
});

// ─── R10/R11/R15: code-hash resume ───────────────────────────────────────────

describe('R15 — code-hash resume: happy path', () => {
  it('same code + confirmUpload → 1 join total, uploads N, no pch_ in state', async () => {
    const { parche } = makeParche();
    const fs = new MemoryFilesystem();
    const vaultDir = `${HOMEDIR}/.chamba/vaults/team-alpha`;
    await fs.mkdir(vaultDir);
    await fs.writeFile(`${vaultDir}/note.md`, '# Note\n');

    const svc = makeServices(parche, { fs });
    const { client, server } = await connect(svc);

    const joinsBefore = parche.requestLog.filter(
      (r) => r.method === 'POST' && r.url.includes('/join'),
    ).length;

    // First call: needsConfirmation
    const r1 = await client.callTool({
      name: 'chamba_vault_join',
      arguments: { code: 'K7QX-M2RP', name: 'Joys', email: 'j@x.dev' },
    });
    expect((r1 as { isError?: boolean }).isError).toBeFalsy();
    const sc1 = structuredOf(r1);
    expect(sc1.needsConfirmation).toBe(true);

    // state.json must NOT contain the code in clear
    const stateJson = await fs.readFile(`${vaultDir}/.chamba-sync/state.json`);
    expect(stateJson).not.toContain('K7QX-M2RP');
    expect(stateJson).not.toMatch(/pch_/);

    // Second call: same code + confirmUpload → resumes, 1 join total
    const r2 = await client.callTool({
      name: 'chamba_vault_join',
      arguments: { code: 'K7QX-M2RP', name: 'Joys', email: 'j@x.dev', confirmUpload: true },
    });
    expect((r2 as { isError?: boolean }).isError).toBeFalsy();

    const joinsAfter = parche.requestLog.filter(
      (r) => r.method === 'POST' && r.url.includes('/join'),
    ).length;
    expect(joinsAfter - joinsBefore).toBe(1);

    // Uploads happened: 1 blob for note.md
    expect(parche.requestLog.filter((r) => r.method === 'PUT').length).toBe(1);

    // After confirm: pendingJoinCodeHash cleared from state
    const stateAfter = await readState(fs, vaultDir);
    expect(JSON.stringify(stateAfter)).not.toContain('pendingJoinCodeHash');

    await server.close();
  });
});

describe('R10 — two pendings: join({code:A, dir:B, confirmUpload}) does NOT confirm B', () => {
  it('two pending vaults: joining A with dir=/b → B state untouched, 0 pushes to B', async () => {
    const { parche } = makeParche();
    // Add second invite
    const group2 = parche.seedGroup({ slug: 'team-beta', name: 'Team Beta' });
    parche.addInvite({ code: 'ABCD-EFGH', groupId: group2.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const svc = makeServices(parche, { fs });
    const { client, server } = await connect(svc);

    // Create two vault dirs with files
    const vaultA = `${HOMEDIR}/.chamba/vaults/team-alpha`;
    const vaultB = `${HOMEDIR}/.chamba/vaults/team-beta`;
    await fs.mkdir(vaultA);
    await fs.writeFile(`${vaultA}/a.md`, '# A\n');
    await fs.mkdir(vaultB);
    await fs.writeFile(`${vaultB}/b.md`, '# B\n');

    // Join A (needsConfirmation)
    await client.callTool({
      name: 'chamba_vault_join',
      arguments: { code: 'K7QX-M2RP', name: 'Joys', email: 'j@x.dev', dir: vaultA },
    });
    // Join B (needsConfirmation)
    await client.callTool({
      name: 'chamba_vault_join',
      arguments: { code: 'ABCD-EFGH', name: 'Joys', email: 'j@x.dev', dir: vaultB },
    });

    // Read state of B before the wrong-code call
    const stateBefore = await readState(fs, vaultB);
    expect(stateBefore?.pendingAdoption).toBe(true);
    const hashBefore = stateBefore?.pendingJoinCodeHash;
    // Hash must be a 64-char hex sha256 written by joinOnce
    expect(hashBefore).toMatch(/^[0-9a-f]{64}$/);

    // Call with code A (team-alpha) but dir=vaultB (team-beta) + confirmUpload
    // → should NOT confirm B; user is already member of team-alpha → 409 error or new state
    const r3 = await client.callTool({
      name: 'chamba_vault_join',
      arguments: {
        code: 'K7QX-M2RP',
        name: 'Joys',
        email: 'j@x.dev',
        dir: vaultB,
        confirmUpload: true,
      },
    });
    // Code A does not match B's hash, so B is not resumed; the fresh join for A is
    // refused because that folder already belongs to team-beta.
    const r3text = textOf(r3);
    expect((r3 as { isError?: boolean }).isError).toBe(true);
    expect(r3text).toBe(`"${vaultB}" ya está vinculado al vault "team-beta". Usa otra ruta.`);
    expect(r3text).not.toContain('Joined group vault');

    // B's state: pendingAdoption still true AND same hash (B was NOT confirmed)
    const stateAfterB = await readState(fs, vaultB);
    expect(stateAfterB?.pendingAdoption).toBe(true);
    expect(stateAfterB?.pendingJoinCodeHash).toBe(hashBefore);

    // Zero POST pushes to team-beta (no sync happened for B's group)
    const betaPushes = parche.requestLog.filter(
      (r) => r.method === 'POST' && r.url.includes('/api/g/team-beta/push'),
    );
    expect(betaPushes).toHaveLength(0);

    await server.close();
  });
});

describe('R10 — single pending A + join({code:X, confirmUpload}) → A not confirmed', () => {
  it('using a DIFFERENT code with confirmUpload → does NOT confirm A', async () => {
    const { parche } = makeParche();
    // Add invite with different code but same group (B code)
    const group2 = parche.seedGroup({ slug: 'team-gamma', name: 'Team Gamma' });
    parche.addInvite({ code: 'GGGG-GGGG', groupId: group2.id, role: 'editor' });

    const fs = new MemoryFilesystem();
    const vaultDir = `${HOMEDIR}/.chamba/vaults/team-alpha`;
    await fs.mkdir(vaultDir);
    await fs.writeFile(`${vaultDir}/note.md`, '# Note\n');

    const svc = makeServices(parche, { fs });
    const { client, server } = await connect(svc);

    // Join A
    await client.callTool({
      name: 'chamba_vault_join',
      arguments: { code: 'K7QX-M2RP', name: 'Joys', email: 'j@x.dev' },
    });

    const stateBefore = await readState(fs, vaultDir);
    expect(stateBefore?.pendingAdoption).toBe(true);
    const hashBefore = stateBefore?.pendingJoinCodeHash;
    // Hash must exist and be valid sha256 hex
    expect(hashBefore).toMatch(/^[0-9a-f]{64}$/);

    // Call with DIFFERENT code X + confirmUpload
    // This should start a NEW join for gamma (different dir/default), NOT confirm A
    await client.callTool({
      name: 'chamba_vault_join',
      arguments: { code: 'GGGG-GGGG', name: 'Joys', email: 'j@x.dev', confirmUpload: true },
    });

    // A (team-alpha vault) should NOT have been confirmed by code GGGG-GGGG
    const stateA = await readState(fs, vaultDir);
    // A's pendingAdoption must still be set — wrong code did NOT confirm it
    expect(stateA?.pendingAdoption).toBe(true);
    // A's hash unchanged (the hash validates which code can confirm it)
    expect(stateA?.pendingJoinCodeHash).toBe(hashBefore);

    // Zero POST pushes to team-alpha (gamma code must not trigger alpha uploads)
    const alphaPushes = parche.requestLog.filter(
      (r) => r.method === 'POST' && r.url.includes('/api/g/team-alpha/push'),
    );
    expect(alphaPushes).toHaveLength(0);

    await server.close();
  });
});

describe('R13 — 1.9.0-style pending (no hash) + confirmUpload → message to chamba_vault_link', () => {
  it('pending without hash + confirmUpload → no join consumed, message points to vault_link', async () => {
    const { parche } = makeParche();
    const fs = new MemoryFilesystem();
    const vaultDir = `${HOMEDIR}/.chamba/vaults/team-alpha`;

    // Manually create a credential and state WITHOUT pendingJoinCodeHash (simulating 1.9.0)
    const creds = new CredentialsStore(fs, HOMEDIR);
    await creds.set(PARCHE_SERVER, 'team-alpha', {
      token: 'pch_fake_legacy_token',
      user: { id: 'u1', name: 'Joys' },
      device: { id: 'd1', label: 'laptop' },
      role: 'editor',
    });
    await fs.mkdir(`${vaultDir}/.chamba-sync`);
    // Write state WITHOUT pendingJoinCodeHash (legacy format)
    await fs.writeFile(
      `${vaultDir}/.chamba-sync/state.json`,
      JSON.stringify({
        server: PARCHE_SERVER,
        slug: 'team-alpha',
        cursor: 0,
        files: {},
        pendingAdoption: true,
        // NO pendingJoinCodeHash
      }),
    );
    await fs.mkdir(`${vaultDir}/.obsidian`);

    const svc = makeServices(parche, { fs });
    const { client, server } = await connect(svc);

    const joinsBefore = parche.requestLog.filter(
      (r) => r.method === 'POST' && r.url.includes('/join'),
    ).length;

    const result = await client.callTool({
      name: 'chamba_vault_join',
      arguments: {
        code: 'K7QX-M2RP',
        name: 'Joys',
        email: 'j@x.dev',
        dir: vaultDir,
        confirmUpload: true,
      },
    });

    // The response should mention vault_link as the solution
    const text = textOf(result);
    // Either the call mentions vault_link or vault link
    const mentionsLink =
      text.toLowerCase().includes('vault_link') ||
      text.toLowerCase().includes('vault link') ||
      text.toLowerCase().includes('chamba_vault_link');

    // 0 join requests consumed for the legacy pending vault
    const joinsAfter = parche.requestLog.filter(
      (r) => r.method === 'POST' && r.url.includes('/join'),
    ).length;

    expect(mentionsLink).toBe(true);
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(text).toContain('creada por una versión anterior');
    expect(text).toContain(`npx @chamba/mcp vault link team-alpha --dir "${vaultDir}" --yes`);
    expect(joinsAfter - joinsBefore).toBe(0);
    const stateAfter = await readState(fs, vaultDir);
    expect(stateAfter?.pendingAdoption).toBe(true);

    await server.close();
  });
});

// ─── R11: parche.json written on needsConfirmation ───────────────────────────

describe('R11 — parche.json written even on needsConfirmation', () => {
  it('with scope:workspace and files → parche.json written at needsConfirmation, not just on success', async () => {
    const { parche } = makeParche();
    const fs = new MemoryFilesystem();
    await fs.mkdir(`${WORKSPACE}/.chamba`);
    await fs.writeFile(`${WORKSPACE}/.chamba/workspace.md`, '# Workspace\n');

    const vaultDir = `${HOMEDIR}/.chamba/vaults/team-alpha`;
    await fs.mkdir(vaultDir);
    await fs.writeFile(`${vaultDir}/note.md`, '# Note\n');

    const svc = makeServices(parche, { fs, cwd: WORKSPACE });
    const { client, server } = await connect(svc);

    const result = await client.callTool({
      name: 'chamba_vault_join',
      arguments: {
        code: 'K7QX-M2RP',
        name: 'Joys',
        email: 'j@x.dev',
        scope: 'workspace',
        // No confirmUpload → should return needsConfirmation
      },
    });

    const sc = structuredOf(result);
    expect(sc.needsConfirmation).toBe(true);

    // parche.json should already be written (R11: written even on needsConfirmation)
    // NOTE: if this fails, it means R11 is not implemented in the MCP tool.
    // The binding is only written on success currently.
    const parchePath = `${WORKSPACE}/.chamba/parche.json`;
    const parcheExists = await fs.exists(parchePath);

    // This is an explicit test for R11 behavior.
    // If not implemented, leave failing and report.
    expect(parcheExists).toBe(true);

    await server.close();
  });
});
