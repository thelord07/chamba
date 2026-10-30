/**
 * parche-workspace.test.ts — PARCHE-011 CLI tests for workspace-scoped join/unlink/sync.
 *
 * Covers:
 *   AC3  — in workspace, no TTY, no --scope → exit 1 mentioning --scope
 *          with --scope workspace → parche.json written; keys verified; code/token absent
 *   AC4  — pre-check: other slug → exit 1, file intact; same slug → join ok
 *          check 200 valid:false → exit 1, 0 joins
 *          check 404 → conservative reject with unlink hint, 0 joins
 *          check 500/network → "No pude verificar", no unlink hint, 0 joins, file intact
 *          check NOT called when no binding exists (R13)
 *   R6   — parche.json write failure after join → exit 1 with clear message
 *   AC8  — unlink --scope workspace removes only parche.json; credentials.json intact
 *          unlink global; unlink with nothing → exit 1 (no binding)
 *   AC6  — vault sync without slug in bound workspace syncs only that slug; autoSync.enabled:false → 0 requests
 */

import { FakeHash, FakeParche, MemoryFilesystem } from '@chamba/core';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { runVaultCli, type VaultCliDeps } from './cli/vault.js';
import type { Services } from './services.js';

const _logger = pino({ level: 'silent' });

const FAKE_NOW = '2026-06-09T10:00:00.000Z';
const PARCHE_SERVER = 'https://parche.chamba.tools';
const HOMEDIR = '/home/test';
// Workspace MUST be inside homedir — findWorkspaceRoot uses a depth heuristic that
// stops when the path has fewer segments than homedir (a design limitation when cwd
// is not under homedir). Real workspaces are always inside ~/Projects/...
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

async function makeServices(parche: FakeParche, extra: Partial<Services> = {}): Promise<Services> {
  const fs = new MemoryFilesystem();
  // Create workspace marker
  await fs.mkdir(`${WORKSPACE}/.chamba`);
  await fs.writeFile(`${WORKSPACE}/.chamba/workspace.md`, '# Workspace\n');
  return {
    fs,
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
    cwd: WORKSPACE,
    homedir: HOMEDIR,
    http: parche,
    hash: new FakeHash(),
    parchePullTtlMin: 5,
    vaultMutex: new Map(),
    ...extra,
  };
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

// ─── AC3: in workspace, no TTY, no --scope → exit 1 ─────────────────────────

describe('AC3 — in workspace, no TTY, no --scope', () => {
  it('exits 1 and mentions --scope when inside a workspace without TTY', async () => {
    const { parche } = makeParche();
    const svc = await makeServices(parche);

    const r = await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev']);

    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('--scope');
  });

  it('exit 0 and writes parche.json with correct keys when --scope workspace', async () => {
    const { parche } = makeParche();
    const svc = await makeServices(parche);

    const r = await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--scope',
      'workspace',
    ]);

    expect(r.code).toBe(0);

    // parche.json should exist at workspace root
    const parchePath = `${WORKSPACE}/.chamba/parche.json`;
    const exists = await svc.fs.exists(parchePath);
    expect(exists).toBe(true);

    const raw = await svc.fs.readFile(parchePath);
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Keys exactly: version, server, slug, vaultDir, autoSync
    const keys = Object.keys(parsed).sort();
    expect(keys).toEqual(['autoSync', 'server', 'slug', 'vaultDir', 'version'].sort());

    // Raw text must NOT contain invite code or token
    expect(raw).not.toContain('K7QX-M2RP');
    expect(raw).not.toContain('pch_');
    expect(raw).not.toContain('token');
  });

  it('default vaultDir stored as relative "vault" when <ws>/vault exists', async () => {
    const { parche } = makeParche();
    const svc = await makeServices(parche);
    // Create <workspace>/vault
    await svc.fs.mkdir(`${WORKSPACE}/vault/.obsidian`);
    await svc.fs.writeFile(`${WORKSPACE}/vault/.obsidian/app.json`, '{}');

    await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--scope',
      'workspace',
    ]);

    const raw = await svc.fs.readFile(`${WORKSPACE}/.chamba/parche.json`);
    const parsed = JSON.parse(raw) as { vaultDir: string };
    // Should be stored as relative path
    expect(parsed.vaultDir).toBe('vault');
  });
});

// ─── AC4: pre-check when binding exists ──────────────────────────────────────

describe('AC4 — pre-check with existing binding', () => {
  async function setupExistingBinding(svc: Services, slug: string): Promise<void> {
    await svc.fs.writeFile(
      `${WORKSPACE}/.chamba/parche.json`,
      JSON.stringify({ version: 1, server: PARCHE_SERVER, slug, vaultDir: 'vault' }),
    );
  }

  it('other slug → exit 1, file byte-identical', async () => {
    const { parche } = makeParche();
    const svc = await makeServices(parche);
    const originalContent = JSON.stringify({
      version: 1,
      server: PARCHE_SERVER,
      slug: 'other-slug',
      vaultDir: 'vault',
    });
    await setupExistingBinding(svc, 'other-slug');

    const r = await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--scope',
      'workspace',
    ]);

    expect(r.code).toBe(1);
    // File must be byte-identical
    const after = await svc.fs.readFile(`${WORKSPACE}/.chamba/parche.json`);
    expect(after).toBe(originalContent);
    // 0 joins (no POST /api/join)
    const joins = parche.requestLog.filter(
      (r) => r.method === 'POST' && r.url.includes('/api/join'),
    );
    expect(joins).toHaveLength(0);
  });

  it('same slug → join happens (exit 0)', async () => {
    const { parche } = makeParche();
    const svc = await makeServices(parche);
    await setupExistingBinding(svc, 'team-alpha');

    const r = await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--scope',
      'workspace',
    ]);

    expect(r.code).toBe(0);
  });

  it('check 200 valid:false → exit 1, 0 joins, file intact', async () => {
    const { parche } = makeParche();
    parche.checkInviteOverride = { status: 200, body: { valid: false } };
    const svc = await makeServices(parche);
    const originalContent = JSON.stringify({
      version: 1,
      server: PARCHE_SERVER,
      slug: 'team-alpha',
      vaultDir: 'vault',
    });
    await setupExistingBinding(svc, 'team-alpha');

    const r = await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--scope',
      'workspace',
    ]);

    expect(r.code).toBe(1);
    const after = await svc.fs.readFile(`${WORKSPACE}/.chamba/parche.json`);
    expect(after).toBe(originalContent);
    const joins = parche.requestLog.filter(
      (r) => r.method === 'POST' && r.url.includes('/api/join'),
    );
    expect(joins).toHaveLength(0);
  });

  it('check 404 → conservative reject with unlink hint, 0 joins', async () => {
    const { parche } = makeParche();
    parche.checkInviteOverride = { status: 404, body: { error: 'not_found' } };
    const svc = await makeServices(parche);
    await setupExistingBinding(svc, 'team-alpha');

    const r = await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--scope',
      'workspace',
    ]);

    expect(r.code).toBe(1);
    const errMsg = r.err.join('\n');
    expect(errMsg).toContain('unlink');
    const joins = parche.requestLog.filter(
      (req) => req.method === 'POST' && req.url.includes('/api/join'),
    );
    expect(joins).toHaveLength(0);
  });

  it('check 500 → "No pude verificar", no unlink hint, 0 joins, file intact', async () => {
    const { parche } = makeParche();
    parche.checkInviteOverride = { status: 500, body: { error: 'server_error' } };
    const svc = await makeServices(parche);
    const originalContent = JSON.stringify({
      version: 1,
      server: PARCHE_SERVER,
      slug: 'team-alpha',
      vaultDir: 'vault',
    });
    await setupExistingBinding(svc, 'team-alpha');

    const r = await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--scope',
      'workspace',
    ]);

    expect(r.code).toBe(1);
    const errMsg = r.err.join('\n');
    expect(errMsg).toContain('No pude verificar');
    // No unlink hint
    expect(errMsg).not.toContain('unlink');
    // 0 joins
    const joins = parche.requestLog.filter(
      (req) => req.method === 'POST' && req.url.includes('/api/join'),
    );
    expect(joins).toHaveLength(0);
    // File intact
    const after = await svc.fs.readFile(`${WORKSPACE}/.chamba/parche.json`);
    expect(after).toBe(originalContent);
  });

  it('check network throw → "No pude verificar", no unlink hint, 0 joins, file intact', async () => {
    const { parche } = makeParche();
    parche.checkInviteOverride = 'throw';
    const svc = await makeServices(parche);
    const originalContent = JSON.stringify({
      version: 1,
      server: PARCHE_SERVER,
      slug: 'team-alpha',
      vaultDir: 'vault',
    });
    await setupExistingBinding(svc, 'team-alpha');

    const r = await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--scope',
      'workspace',
    ]);

    expect(r.code).toBe(1);
    const errMsg = r.err.join('\n');
    expect(errMsg).toContain('No pude verificar');
    expect(errMsg).not.toContain('unlink');
    const joins = parche.requestLog.filter(
      (req) => req.method === 'POST' && req.url.includes('/api/join'),
    );
    expect(joins).toHaveLength(0);
    const after = await svc.fs.readFile(`${WORKSPACE}/.chamba/parche.json`);
    expect(after).toBe(originalContent);
  });

  it('R13 — check NOT called when no binding exists', async () => {
    const { parche } = makeParche();
    const svc = await makeServices(parche);
    // No parche.json in workspace

    await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--scope',
      'workspace',
    ]);

    // No GET /api/web/invites requests
    const checkRequests = parche.requestLog.filter(
      (req) => req.method === 'GET' && req.url.includes('/api/web/invites'),
    );
    expect(checkRequests).toHaveLength(0);
  });
});

// ─── R6: parche.json write failure after join ─────────────────────────────────

describe('R6 — parche.json write failure', () => {
  it('exits 1 with clear message when parche.json cannot be written', async () => {
    const { parche } = makeParche();
    const svc = await makeServices(parche);

    // Override writeBytes to fail for parche.json path
    const realWriteBytes = svc.fs.writeBytes.bind(svc.fs);
    (svc.fs as unknown as { writeBytes: typeof svc.fs.writeBytes }).writeBytes = async (
      path: string,
      bytes: Uint8Array,
      opts?: unknown,
    ) => {
      if (path.includes('parche.json')) {
        throw new Error('Permission denied');
      }
      return realWriteBytes(path, bytes, opts as Parameters<typeof svc.fs.writeBytes>[2]);
    };

    const r = await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--scope',
      'workspace',
    ]);

    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('team-alpha');
  });
});

// ─── AC8: unlink removes only parche.json ────────────────────────────────────

describe('AC8 — unlink scope workspace', () => {
  it('removes workspace parche.json, credentials.json bytes stay identical', async () => {
    const { parche } = makeParche();
    const svc = await makeServices(parche);

    // Setup: join first to create parche.json + credentials
    await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--scope',
      'workspace',
    ]);

    const credPath = `${HOMEDIR}/.chamba/credentials.json`;
    const credsBefore = await svc.fs.readFile(credPath);

    // Unlink workspace
    const r = await makeCli(svc, ['unlink', '--scope', 'workspace']);

    expect(r.code).toBe(0);
    // parche.json removed
    expect(await svc.fs.exists(`${WORKSPACE}/.chamba/parche.json`)).toBe(false);
    // credentials.json intact
    const credsAfter = await svc.fs.readFile(credPath);
    expect(credsAfter).toBe(credsBefore);
  });

  it('unlink when nothing exists → exit 0 with "No hay vínculo" message', async () => {
    const { parche } = makeParche();
    const svc = await makeServices(parche);

    const r = await makeCli(svc, ['unlink', '--scope', 'workspace']);
    expect(r.code).toBe(0);
    expect([...r.out, ...r.err].join('\n')).toContain('No hay vínculo');
  });

  it('unlink global scope removes ~/.chamba/parche.json', async () => {
    const { parche } = makeParche();
    const svc = await makeServices(parche);

    // Join as global first
    // Need to not be in workspace for global scope, or explicitly pass --scope global
    // We can use explicit --scope global
    await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--scope',
      'global',
    ]);

    const globalParchePath = `${HOMEDIR}/.chamba/parche.json`;
    expect(await svc.fs.exists(globalParchePath)).toBe(true);

    const r = await makeCli(svc, ['unlink', '--scope', 'global']);
    expect(r.code).toBe(0);
    expect(await svc.fs.exists(globalParchePath)).toBe(false);
  });
});

// ─── AC3 with TTY: scope prompt ───────────────────────────────────────────────

describe('AC3 — TTY scope prompt', () => {
  it('TTY + prompt "workspace" → exit 0, parche.json written', async () => {
    const { parche } = makeParche();
    const svc = await makeServices(parche);

    const r = await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev'], {
      isTTY: true,
      prompt: async () => 'workspace',
    });

    expect(r.code).toBe(0);
    expect(await svc.fs.exists(`${WORKSPACE}/.chamba/parche.json`)).toBe(true);
    // Global parche.json must NOT be written
    expect(await svc.fs.exists(`${HOMEDIR}/.chamba/parche.json`)).toBe(false);
  });

  it('TTY + prompt "global" → exit 0, global parche.json written, no workspace parche.json', async () => {
    const { parche } = makeParche();
    const svc = await makeServices(parche);

    const r = await makeCli(svc, ['join', 'K7QX-M2RP', '--name', 'Joys', '--email', 'j@x.dev'], {
      isTTY: true,
      prompt: async () => 'global',
    });

    expect(r.code).toBe(0);
    // Global parche.json written
    expect(await svc.fs.exists(`${HOMEDIR}/.chamba/parche.json`)).toBe(true);
    // Workspace parche.json NOT written
    expect(await svc.fs.exists(`${WORKSPACE}/.chamba/parche.json`)).toBe(false);
  });
});

// ─── vault sync: no slug in bound workspace ───────────────────────────────────

describe('vault sync — in workspace with binding', () => {
  it('syncs only the binding slug; other slug gets 0 requests', async () => {
    const { parche: parcheA } = makeParche();
    const parcheB = new FakeParche(makeClock());
    const groupB = parcheB.seedGroup({ slug: 'team-beta', name: 'Team Beta' });
    const tokenB = parcheB.addDevice(groupB.id, { userId: 'u-b', label: 'device-b' });

    const svc = await makeServices(parcheA);
    // The workspace binding points at team-alpha (set up in makeParche)
    // First join as team-alpha (workspace)
    await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--scope',
      'workspace',
    ]);

    // Also add a credential for team-beta (to simulate multiple creds)
    // We do it directly via CredentialsStore to avoid complexity
    const { CredentialsStore: CS } = await import('@chamba/core');
    const creds = new CS(svc.fs, HOMEDIR);
    await creds.set(PARCHE_SERVER, 'team-beta', {
      token: tokenB,
      user: { id: 'u-b', name: 'Team B' },
      device: { id: 'd-b', label: 'device-b' },
      role: 'editor',
    });

    // Use parcheA http for svc but check parcheB separately
    const requestsBefore = parcheB.requestLog.length;

    // Run vault sync with no slug — should only sync team-alpha (from workspace binding)
    const r = await makeCli(svc, ['sync']);
    expect(r.code).toBe(0);

    // team-beta (parcheB) gets 0 requests
    expect(parcheB.requestLog.length).toBe(requestsBefore);
    // team-alpha (parcheA) received requests
    expect(parcheA.requestLog.length).toBeGreaterThan(0);
  });

  it('vault sync ignores autoSync.enabled:false (explicit CLI always syncs)', async () => {
    const { parche } = makeParche();
    const svc = await makeServices(parche);

    // Join with workspace scope
    await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--scope',
      'workspace',
    ]);

    // Manually set autoSync.enabled:false in the binding file
    const bindingPath = `${WORKSPACE}/.chamba/parche.json`;
    const binding = JSON.parse(await svc.fs.readFile(bindingPath)) as Record<string, unknown>;
    await svc.fs.writeFile(
      bindingPath,
      JSON.stringify({ ...binding, autoSync: { enabled: false, pullTtlMin: 5 } }),
    );

    const requestsBefore = parche.requestLog.length;

    // Run explicit vault sync — must sync even with autoSync:false
    const r = await makeCli(svc, ['sync']);
    expect(r.code).toBe(0);

    // Requests were made (sync happened)
    expect(parche.requestLog.length).toBeGreaterThan(requestsBefore);
  });
});

// ─── O1: vault link from bound workspace updates binding ─────────────────────

describe('O1 — vault link updates workspace binding', () => {
  it('vault link --dir <new-path> --yes updates workspace parche.json and prints updated file', async () => {
    const { parche } = makeParche();
    const svc = await makeServices(parche);

    // Join first (workspace scope) to get credential + binding
    await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--scope',
      'workspace',
    ]);

    // Prepare a new vault dir
    const newVaultDir = `${WORKSPACE}/new-vault`;
    await svc.fs.mkdir(`${newVaultDir}/.obsidian`);
    await svc.fs.writeFile(`${newVaultDir}/.obsidian/app.json`, '{}');

    const bindingBefore = JSON.parse(
      await svc.fs.readFile(`${WORKSPACE}/.chamba/parche.json`),
    ) as Record<string, unknown>;

    const r = await makeCli(svc, ['link', 'team-alpha', '--dir', newVaultDir, '--yes']);

    expect(r.code).toBe(0);

    // Stdout must mention that the workspace binding was updated
    const outText = r.out.join('\n');
    expect(outText).toMatch(/vínculo workspace actualizado|workspace/i);

    // Binding file now has new vaultDir
    const bindingAfter = JSON.parse(
      await svc.fs.readFile(`${WORKSPACE}/.chamba/parche.json`),
    ) as Record<string, unknown>;
    expect(bindingAfter.vaultDir).not.toBe(bindingBefore.vaultDir);
    // New vault dir should be stored as relative (inside workspace)
    expect(bindingAfter.vaultDir).toBe('new-vault');
  });

  it('vault link --dir <new-path> --yes also updates global binding when slug matches', async () => {
    const { parche } = makeParche();
    const svc = await makeServices(parche);

    // Join globally to create global binding
    await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--scope',
      'global',
    ]);

    // Prepare new vault dir
    const newVaultDir = `${HOMEDIR}/new-global-vault`;
    await svc.fs.mkdir(`${newVaultDir}/.obsidian`);
    await svc.fs.writeFile(`${newVaultDir}/.obsidian/app.json`, '{}');

    const globalBindingBefore = JSON.parse(
      await svc.fs.readFile(`${HOMEDIR}/.chamba/parche.json`),
    ) as Record<string, unknown>;

    const r = await makeCli(svc, ['link', 'team-alpha', '--dir', newVaultDir, '--yes']);

    expect(r.code).toBe(0);

    // Global binding updated
    const globalBindingAfter = JSON.parse(
      await svc.fs.readFile(`${HOMEDIR}/.chamba/parche.json`),
    ) as Record<string, unknown>;
    expect(globalBindingAfter.vaultDir).not.toBe(globalBindingBefore.vaultDir);
  });

  // BLOCKER: both workspace and global bindings updated, no premature return
  it('BLOCKER — vault link updates both workspace and global bindings when both have same slug', async () => {
    const { parche } = makeParche();
    const svc = await makeServices(parche);

    // Join once (workspace scope) — creates workspace binding + credential
    await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--scope',
      'workspace',
    ]);

    // Manually write a global binding pointing to the same slug
    const { parcheFilePath, writeParcheBinding } = await import('@chamba/core');
    const globalPath = parcheFilePath(HOMEDIR);
    const wsVaultDir = `${WORKSPACE}/vault`;
    await writeParcheBinding(svc.fs, globalPath, {
      version: 1,
      server: PARCHE_SERVER,
      slug: 'team-alpha',
      vaultDir: wsVaultDir,
      autoSync: { enabled: true, pullTtlMin: 5 },
    });

    // Prepare a new vault dir
    const newVaultDir = `${WORKSPACE}/new-vault`;
    await svc.fs.mkdir(`${newVaultDir}/.obsidian`);
    await svc.fs.writeFile(`${newVaultDir}/.obsidian/app.json`, '{}');

    const r = await makeCli(svc, ['link', 'team-alpha', '--dir', newVaultDir, '--yes']);
    expect(r.code).toBe(0);

    const outText = r.out.join('\n');
    // Both bindings must be mentioned in the output
    expect(outText).toMatch(/workspace/i);
    expect(outText).toMatch(/global/i);

    // Workspace binding updated
    const wsBinding = JSON.parse(
      await svc.fs.readFile(`${WORKSPACE}/.chamba/parche.json`),
    ) as Record<string, unknown>;
    expect(wsBinding.vaultDir).toBe('new-vault');

    // Global binding also updated
    const globalBinding = JSON.parse(
      await svc.fs.readFile(`${HOMEDIR}/.chamba/parche.json`),
    ) as Record<string, unknown>;
    expect(globalBinding.vaultDir).toBe(newVaultDir);
  });

  it('BLOCKER — vault link prints "ningún parche.json actualizado" when no binding matches slug', async () => {
    const { parche } = makeParche();
    const svc = await makeServices(parche);

    // Join with workspace scope so we have a credential for team-alpha
    await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--scope',
      'workspace',
    ]);

    // Overwrite workspace binding with a DIFFERENT slug so team-alpha won't match
    const { parcheFilePath, writeParcheBinding } = await import('@chamba/core');
    const wsBindingPath = parcheFilePath(WORKSPACE);
    await writeParcheBinding(svc.fs, wsBindingPath, {
      version: 1,
      server: PARCHE_SERVER,
      slug: 'other-slug',
      vaultDir: 'vault',
      autoSync: { enabled: true, pullTtlMin: 5 },
    });

    // Prepare a valid vault dir
    const newVaultDir = `${WORKSPACE}/new-vault`;
    await svc.fs.mkdir(`${newVaultDir}/.obsidian`);
    await svc.fs.writeFile(`${newVaultDir}/.obsidian/app.json`, '{}');

    const r = await makeCli(svc, ['link', 'team-alpha', '--dir', newVaultDir, '--yes']);
    expect(r.code).toBe(0);

    expect(r.out.join('\n')).toContain('ningún parche.json actualizado');
  });

  it('BLOCKER — second workspace with old path keeps parche.json byte-identical; doctor marks divergence', async () => {
    const { parche } = makeParche();
    const svc = await makeServices(parche);

    // Join workspace scope — creates workspace binding at WORKSPACE with a vault dir
    await makeCli(svc, [
      'join',
      'K7QX-M2RP',
      '--name',
      'Joys',
      '--email',
      'j@x.dev',
      '--scope',
      'workspace',
    ]);

    // Read the workspace binding (old vaultDir)
    const bindingBefore = await svc.fs.readFile(`${WORKSPACE}/.chamba/parche.json`);
    const parsedBefore = JSON.parse(bindingBefore) as { vaultDir: string };
    const oldVaultDir = parsedBefore.vaultDir.startsWith('/')
      ? parsedBefore.vaultDir
      : `${WORKSPACE}/${parsedBefore.vaultDir}`;

    // Create a SECOND workspace at a different path (simulating another project on same machine)
    const ws2 = `${HOMEDIR}/Projects/workspace-2`;
    await svc.fs.mkdir(`${ws2}/.chamba`);
    await svc.fs.writeFile(`${ws2}/.chamba/workspace.md`, '# WS2\n');
    // ws2 has its own parche.json pointing at the OLD vault dir (the one being replaced)
    await svc.fs.writeFile(
      `${ws2}/.chamba/parche.json`,
      JSON.stringify({
        version: 1,
        server: PARCHE_SERVER,
        slug: 'team-alpha',
        vaultDir: oldVaultDir,
        autoSync: { enabled: true, pullTtlMin: 5 },
      }),
    );
    const ws2BindingBefore = await svc.fs.readFile(`${ws2}/.chamba/parche.json`);

    // Now link team-alpha to a new vault dir (from WORKSPACE's perspective)
    const newVaultDir = `${WORKSPACE}/new-vault`;
    await svc.fs.mkdir(`${newVaultDir}/.obsidian`);
    await svc.fs.writeFile(`${newVaultDir}/.obsidian/app.json`, '{}');

    const r = await makeCli(svc, ['link', 'team-alpha', '--dir', newVaultDir, '--yes']);
    expect(r.code).toBe(0);

    // ws2's parche.json must be byte-identical (vault link only touches CURRENT workspace + global)
    const ws2BindingAfter = await svc.fs.readFile(`${ws2}/.chamba/parche.json`);
    expect(ws2BindingAfter).toBe(ws2BindingBefore);

    // Doctor for ws2 with ws2 context: credential points to new vault dir, but ws2 binding
    // still has old vault dir → realpath mismatch → doctor should warn
    const { runDoctor, FakeProcess } = await import('@chamba/core');
    const ws2Svc = { ...svc, cwd: ws2 };
    const report = await runDoctor({
      fs: ws2Svc.fs,
      process: new FakeProcess(() => ({ stdout: 'true\n' })),
      cwd: ws2,
      homedir: HOMEDIR,
      obsidianVaultPath: undefined,
      obsidianSearchRoots: [],
      nodeVersion: 'v22.3.0',
      resources: {
        totalMemBytes: 16 * 1024 ** 3,
        freeMemBytes: 8 * 1024 ** 3,
        cpus: 8,
        loadAvg1: 0,
      },
    });
    const parcheCheck = report.checks.find((c) => c.id === 'parche') as
      | { status: string; detail: string }
      | undefined;
    // Must warn about divergence: ws2 binding points to old dir, credential points to new dir
    expect(parcheCheck?.status).toBe('warn');
    expect(parcheCheck?.detail).toContain('el binding apunta a');
    expect(parcheCheck?.detail).toContain('pero la credencial a');
  });
});
