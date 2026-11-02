/**
 * parche-windows-e2e.test.ts — CHAMBA-015 S19 / Test 6 (E2E).
 *
 * End-to-end test that runs on the real OS (macOS, ubuntu, windows in CI).
 * Uses:
 *  - NodeFilesystem (real FS — real OS path semantics)
 *  - FakeParche (in-process HTTP — no real sockets)
 *  - NodeHash (real SHA-256)
 *  - Temp directories created with mkdtemp (never HOME/~/.chamba)
 *  - runVaultCli wired to injected services (no process.env reads)
 *
 * Sequence per ticket §4:
 *  1. workspace with existing `<ws>/vault` containing notes
 *  2. vault join <code> --scope workspace --dir <abs path>
 *       → no TTY, no --yes → no upload, exit ≠ 0
 *  3. vault join ... --yes → upload (adoption gate passes)
 *  4. sync: push+pull (remote file arrives)
 *  5. link to another dir
 *  6. resync --yes
 *  7. unlink --scope workspace (only parche.json removed; creds & files intact)
 *
 * CHAMBA-015 AC1,AC2,AC3 verification on real filesystem.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFilesystem, NodeHash } from '@chamba/adapters';
import { FakeHash, FakeParche, findWorkspaceRoot } from '@chamba/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runVaultCli, type VaultCliDeps } from './cli/vault.js';
import type { Services } from './services.js';

// ─── Clock helper ─────────────────────────────────────────────────────────────

function makeClock(iso = '2026-11-02T10:00:00.000Z') {
  const d = new Date(iso);
  return {
    now: () => d,
    today: () => iso.slice(0, 10),
    sleep: () => Promise.resolve(),
  };
}

// ─── CLI runner helper ────────────────────────────────────────────────────────

function makeCli(
  svc: Services,
  argv: string[],
  opts: { isTTY?: boolean; prompt?: (q: string) => Promise<string> } = {},
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
    prompt: opts.prompt ?? (async () => ''),
    isTTY: opts.isTTY ?? false,
    hostname: 'e2e-laptop',
  };
  return runVaultCli(argv, deps).then(() => ({ out, err, code }));
}

// ─── Test suite ──────────────────────────────────────────────────────────────

describe('S19 — E2E parche Windows/cross-platform (CHAMBA-015)', () => {
  let tempRoot: string;
  let parche: FakeParche;
  let services: Services;
  let vaultDir: string;
  let workspaceDir: string;
  let homedirForTest: string;
  let seedGroupId: string;

  beforeEach(async () => {
    // All dirs live under a temp root — never HOME or ~/.chamba
    tempRoot = await mkdtemp(join(tmpdir(), 'chamba-e2e-'));
    workspaceDir = join(tempRoot, 'workspace');
    vaultDir = join(workspaceDir, 'vault');
    homedirForTest = join(tempRoot, 'home');

    // Create directory structure
    const realFs = new NodeFilesystem();
    await realFs.mkdir(workspaceDir);
    await realFs.mkdir(vaultDir);
    await realFs.mkdir(homedirForTest);

    // Seed a note in the vault BEFORE join (adoption scenario)
    await realFs.writeFile(
      join(vaultDir, 'existing-note.md'),
      '# Existing Note\n\nThis was here before join.',
    );

    const clock = makeClock();
    parche = new FakeParche(clock);
    const group = parche.seedGroup({ slug: 'e2e-vault', name: 'E2E Vault' });
    seedGroupId = group.id;
    parche.addInvite({ code: 'E2E1-ABCD', groupId: group.id, role: 'editor' });

    // Resolve workspaceRoot and vaultDir via realpath so symlinks (e.g. macOS
    // /var/folders → /private/var/folders) don't create a mismatch between
    // services.workspaceRoot and the canonicalDir produced by prepareVaultDir
    // (which also calls fs.realpath internally).
    const realWorkspaceDir = await realFs.realpath(workspaceDir);
    const realVaultDir = await realFs.realpath(vaultDir);

    services = {
      fs: new NodeFilesystem(),
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
      cwd: realWorkspaceDir,
      homedir: homedirForTest,
      http: parche,
      hash: new NodeHash(),
      parchePullTtlMin: 5,
      vaultMutex: new Map(),
      platform: process.platform,
      username: 'e2e-testuser',
      workspaceRoot: realWorkspaceDir,
    };

    // Update module-level vars to use realpath-resolved paths for consistent assertions
    workspaceDir = realWorkspaceDir;
    vaultDir = realVaultDir;
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  // ── Step 2: join without --yes → no upload, exit ≠ 0 ─────────────────────

  it('join without --yes and no TTY → asks for confirmation, exit ≠ 0', async () => {
    const { out, err, code } = await makeCli(
      services,
      [
        'join',
        'E2E1-ABCD',
        '--name',
        'E2E User',
        '--email',
        'e2e@test.com',
        '--scope',
        'workspace',
        '--dir',
        vaultDir,
      ],
      { isTTY: false },
    );

    // Without --yes, the join should report needsConfirmation or exit non-zero
    const allOutput = [...out, ...err].join('\n');
    expect(code).not.toBe(0);
    expect(allOutput.length).toBeGreaterThan(0);

    // The vault files should NOT have been pushed to the server
    const puts = parche.requestLog.filter((r) => r.method === 'PUT');
    expect(puts).toHaveLength(0);
  });

  // ── Step 3: join --yes → upload succeeds ─────────────────────────────────

  it('join --yes → adoption gate passes, local file uploaded', async () => {
    const { code } = await makeCli(services, [
      'join',
      'E2E1-ABCD',
      '--name',
      'E2E User',
      '--email',
      'e2e@test.com',
      '--scope',
      'workspace',
      '--dir',
      vaultDir,
      '--yes',
    ]);

    // With --yes, join should succeed
    expect(code).toBe(0);

    // File should have been uploaded (PUT to blob store)
    const puts = parche.requestLog.filter((r) => r.method === 'PUT');
    expect(puts.length).toBeGreaterThan(0);

    // parche.json should exist in workspace at <ws>/.chamba/parche.json
    // (parcheFilePath returns joinPath(root, '.chamba', 'parche.json'))
    const parcheJsonPath = join(workspaceDir, '.chamba', 'parche.json');
    const realFs = new NodeFilesystem();
    expect(await realFs.exists(parcheJsonPath)).toBe(true);
  });

  // ── Step 4: sync — push + pull (remote file arrives) ─────────────────────

  it('sync pulls a remote file that arrives after join', async () => {
    // First: join --yes
    await makeCli(services, [
      'join',
      'E2E1-ABCD',
      '--name',
      'E2E User',
      '--email',
      'e2e@test.com',
      '--scope',
      'workspace',
      '--dir',
      vaultDir,
      '--yes',
    ]);

    // Seed a new remote file on the server
    const remoteContent = new TextEncoder().encode('# Remote File\n\nAdded by another member.');
    const fakeHash = new FakeHash();
    const remoteHash = await fakeHash.sha256(remoteContent);

    // Seed blob + change onto the group created in beforeEach
    parche.seedBlob(seedGroupId, remoteHash, remoteContent);
    parche.seedChange(seedGroupId, {
      path: 'remote-note.md',
      hash: remoteHash,
      author: 'other-member',
      device: 'other-device',
      at: '2026-11-02T10:00:00Z',
    });

    // Sync to pull the remote file
    const { code, out } = await makeCli(services, ['sync']);
    expect(code).toBe(0);

    // remote-note.md should now exist in vault
    const realFs = new NodeFilesystem();
    const pulledFile = join(vaultDir, 'remote-note.md');
    expect(await realFs.exists(pulledFile)).toBe(true);

    // Output should mention pulled files
    const allOut = out.join('\n');
    expect(allOut).toMatch(/pull/i);
  });

  // ── Step 5: link → new dir gets files from server, old dir untouched ────────

  it('link → files pulled into new dir, old dir untouched, parche.json has relative vaultDir (v1)', async () => {
    // Join first to establish binding and upload existing-note.md
    await makeCli(services, [
      'join',
      'E2E1-ABCD',
      '--name',
      'E2E User',
      '--email',
      'e2e@test.com',
      '--scope',
      'workspace',
      '--dir',
      vaultDir,
      '--yes',
    ]);

    // Create a second vault directory (empty — link will pull remote files into it)
    const realFs = new NodeFilesystem();
    const vault2Dir = join(workspaceDir, 'vault2');
    await realFs.mkdir(vault2Dir);

    // Link e2e-vault to vault2
    const { code: linkCode, err: linkErr } = await makeCli(services, [
      'link',
      'e2e-vault',
      '--dir',
      vault2Dir,
      '--yes',
    ]);
    expect(linkCode).toBe(0);
    expect(linkErr.filter((e) => /error/i.test(e))).toHaveLength(0);

    // vault2 should now contain the file that was on the server (existing-note.md
    // was uploaded during join, so the pull phase of link/finalizeAdoption fetches it)
    expect(await realFs.exists(join(vault2Dir, 'existing-note.md'))).toBe(true);

    // Old vault dir is untouched — link does NOT move or delete files from the previous dir
    expect(await realFs.exists(join(vaultDir, 'existing-note.md'))).toBe(true);

    // parche.json must be a valid v1 binding with the new vaultDir
    const parcheJsonPath = join(workspaceDir, '.chamba', 'parche.json');
    const raw = JSON.parse(await realFs.readFile(parcheJsonPath)) as Record<string, unknown>;
    // Valid v1 binding fields
    expect(raw.version).toBe(1);
    expect(raw.slug).toBe('e2e-vault');
    expect(typeof raw.server).toBe('string');
    expect((raw.server as string).startsWith('https://')).toBe(true);
    // vaultDir stored relative to workspace (vault2 is workspaceDir/vault2 → 'vault2')
    expect(raw.vaultDir).toBe('vault2');
  });

  // ── Step 6: resync → state reset, files intact, sync completes ────────────

  it('resync → state reset in place, vault files intact, sync completes (code 0)', async () => {
    // Join to establish binding
    await makeCli(services, [
      'join',
      'E2E1-ABCD',
      '--name',
      'E2E User',
      '--email',
      'e2e@test.com',
      '--scope',
      'workspace',
      '--dir',
      vaultDir,
      '--yes',
    ]);

    // Sync once to get a clean state
    await makeCli(services, ['sync']);

    // Resync — resets state and re-adopts in place
    const { code: resyncCode, out: resyncOut } = await makeCli(services, [
      'resync',
      'e2e-vault',
      '--yes',
    ]);
    expect(resyncCode).toBe(0);

    // Vault files must be intact after resync (resync does not delete local files)
    const realFs = new NodeFilesystem();
    expect(await realFs.exists(join(vaultDir, 'existing-note.md'))).toBe(true);

    // Output must mention the slug or vault dir
    const allOut = resyncOut.join('\n');
    expect(allOut).toMatch(/e2e-vault/i);
  });

  // ── Step 5→6→7: full chain link → resync → unlink ─────────────────────────

  it('full chain: join → link → resync → unlink (all steps succeed)', async () => {
    const realFs = new NodeFilesystem();
    const parcheJsonPath = join(workspaceDir, '.chamba', 'parche.json');

    // join
    const { code: c1 } = await makeCli(services, [
      'join',
      'E2E1-ABCD',
      '--name',
      'E2E User',
      '--email',
      'e2e@test.com',
      '--scope',
      'workspace',
      '--dir',
      vaultDir,
      '--yes',
    ]);
    expect(c1).toBe(0);

    // link to vault2
    const vault2Dir = join(workspaceDir, 'vault2');
    await realFs.mkdir(vault2Dir);
    const { code: c2 } = await makeCli(services, [
      'link',
      'e2e-vault',
      '--dir',
      vault2Dir,
      '--yes',
    ]);
    expect(c2).toBe(0);

    // resync
    const { code: c3 } = await makeCli(services, ['resync', 'e2e-vault', '--yes']);
    expect(c3).toBe(0);
    expect(await realFs.exists(join(vault2Dir, 'existing-note.md'))).toBe(true);

    // unlink
    const { code: c4 } = await makeCli(services, ['unlink', '--scope', 'workspace']);
    expect(c4).toBe(0);
    expect(await realFs.exists(parcheJsonPath)).toBe(false);
    // vault files survive unlink
    expect(await realFs.exists(join(vault2Dir, 'existing-note.md'))).toBe(true);
  });

  // ── Case-insensitive workspace root (macOS/Windows only) ──────────────────

  // Skipped on Linux: its filesystem is case-sensitive, so an uppercased cwd is a different
  // (non-existent) directory there by design.
  it.skipIf(process.platform === 'linux')(
    'findWorkspaceRoot resolves workspace with differently-cased cwd (case-insensitive FS)',
    async () => {
      // Create workspace marker so findWorkspaceRoot can find the root
      const realFs = new NodeFilesystem();
      await realFs.mkdir(join(workspaceDir, '.chamba'));
      await realFs.writeFile(join(workspaceDir, '.chamba', 'workspace.md'), '# Test Workspace\n');

      // Construct a cwd that has different case than the actual on-disk path.
      // On macOS/Windows (case-insensitive FS) this must still resolve to the workspace.
      const cwdUpperCase = join(vaultDir, '..').toUpperCase();

      const found = await findWorkspaceRoot(realFs, cwdUpperCase, homedirForTest, process.platform);

      // macOS / Windows: case-insensitive FS finds the marker through the uppercased path
      expect(found?.toLowerCase()).toBe(workspaceDir.toLowerCase());
    },
  );

  // ── Step 7: unlink --scope workspace → parche.json removed, files intact ──

  it('unlink --scope workspace → parche.json removed, vault files intact', async () => {
    // Join first
    await makeCli(services, [
      'join',
      'E2E1-ABCD',
      '--name',
      'E2E User',
      '--email',
      'e2e@test.com',
      '--scope',
      'workspace',
      '--dir',
      vaultDir,
      '--yes',
    ]);

    const realFs = new NodeFilesystem();
    // parcheFilePath returns joinPath(root, '.chamba', 'parche.json')
    const parcheJsonPath = join(workspaceDir, '.chamba', 'parche.json');
    expect(await realFs.exists(parcheJsonPath)).toBe(true);

    // Unlink
    const { code } = await makeCli(services, ['unlink', '--scope', 'workspace']);
    expect(code).toBe(0);

    // parche.json should be gone
    expect(await realFs.exists(parcheJsonPath)).toBe(false);

    // But vault files should be intact
    expect(await realFs.exists(join(vaultDir, 'existing-note.md'))).toBe(true);

    // Credentials should still exist (only parche.json is removed by unlink)
    const credsPath = join(homedirForTest, '.chamba', 'credentials.json');
    expect(await realFs.exists(credsPath)).toBe(true);
  });
});
