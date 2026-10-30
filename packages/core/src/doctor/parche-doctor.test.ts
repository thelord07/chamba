/**
 * parche-doctor.test.ts — PARCHE-011 tests for the 'parche' doctor check.
 *
 * Tests:
 *   - no binding → ok
 *   - binding without credential → warn
 *   - vault dir missing → warn
 *   - cred.dir vs binding.vaultDir divergence → warn
 *   - CHAMBA_OBSIDIAN_VAULT_PATH differs from workspace vault → warn mentioning it (AC5)
 *   - workspace source env vs cwd shown (O3)
 *   - explicit "usando vínculo global porque no se detectó workspace desde <cwd>" (O3)
 */

import { describe, expect, it } from 'vitest';
import type { ProcessPort } from '../ports/process.js';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { CredentialsStore } from '../vault-sync/credentials.js';
import { runDoctor } from './doctor.js';

const SERVER = 'https://parche.chamba.tools';
const SLUG = 'team-alpha';
const HOMEDIR = '/home/test';
// Workspace inside homedir (realistic case — paths outside homedir cause findWorkspaceRoot to return null due to path depth heuristic)
const WSROOT = `${HOMEDIR}/Projects/my-project`;
const CWD = `${WSROOT}/src`;
// Default vault dir (what resolveVaultDir returns with no explicit dir)
const DEFAULT_VAULT = `${HOMEDIR}/.chamba/vaults/${SLUG}`;

const noopProcess: ProcessPort = {
  exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
};

function makeInput(
  fs: MemoryFilesystem,
  opts: {
    cwd?: string;
    obsidianVaultPath?: string;
    workspaceRoot?: string;
    workspaceRootSource?: 'env' | 'cwd';
  } = {},
) {
  return {
    fs,
    process: noopProcess,
    cwd: opts.cwd ?? CWD,
    homedir: HOMEDIR,
    obsidianVaultPath: opts.obsidianVaultPath,
    nodeVersion: 'v22.0.0',
    workspaceRoot: opts.workspaceRoot,
    workspaceRootSource: opts.workspaceRootSource,
  };
}

async function writeWorkspaceBinding(
  fs: MemoryFilesystem,
  wsRoot: string,
  slug: string,
  vaultDir: string,
): Promise<void> {
  await fs.mkdir(`${wsRoot}/.chamba`);
  await fs.writeFile(`${wsRoot}/.chamba/workspace.md`, '# WS\n');
  await fs.writeFile(
    `${wsRoot}/.chamba/parche.json`,
    JSON.stringify({ version: 1, server: SERVER, slug, vaultDir }),
  );
}

async function writeGlobalBinding(
  fs: MemoryFilesystem,
  slug: string,
  vaultDir?: string,
): Promise<void> {
  await fs.mkdir(`${HOMEDIR}/.chamba`);
  await fs.writeFile(
    `${HOMEDIR}/.chamba/parche.json`,
    JSON.stringify({
      version: 1,
      server: SERVER,
      slug,
      vaultDir: vaultDir ?? `vaults/${slug}`,
    }),
  );
}

async function writeCred(fs: MemoryFilesystem, slug: string, dir?: string): Promise<void> {
  const creds = new CredentialsStore(fs, HOMEDIR);
  await creds.set(SERVER, slug, {
    token: 'pch_fake_test',
    user: { id: 'u1', name: 'Test' },
    device: { id: 'd1', label: 'laptop' },
    role: 'editor',
    dir,
  });
}

function parcheCheck(checks: Array<{ id: string; status: string; detail: string; hint?: string }>) {
  return checks.find((c) => c.id === 'parche');
}

describe('doctor parche check', () => {
  it('ok — no binding at all', async () => {
    const fs = new MemoryFilesystem();
    const report = await runDoctor(makeInput(fs, { cwd: `${HOMEDIR}/Projects/foo` }));
    const check = parcheCheck(report.checks);
    expect(check).toBeDefined();
    expect(check?.status).toBe('ok');
  });

  it('warn — binding exists but no credential', async () => {
    const fs = new MemoryFilesystem();
    await writeWorkspaceBinding(fs, WSROOT, SLUG, DEFAULT_VAULT);

    const report = await runDoctor(
      makeInput(fs, { workspaceRoot: WSROOT, workspaceRootSource: 'cwd' }),
    );
    const check = parcheCheck(report.checks);
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('sin credencial');
    expect(check?.hint).toContain('npx @chamba/mcp vault');
  });

  it('warn — binding + cred but vault dir missing', async () => {
    const fs = new MemoryFilesystem();
    // Binding with vaultDir pointing to DEFAULT_VAULT (which won't exist)
    await writeWorkspaceBinding(fs, WSROOT, SLUG, DEFAULT_VAULT);
    await writeCred(fs, SLUG, DEFAULT_VAULT);
    // Do NOT create the vault dir

    const report = await runDoctor(
      makeInput(fs, { workspaceRoot: WSROOT, workspaceRootSource: 'cwd' }),
    );
    const check = parcheCheck(report.checks);
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('no existe');
  });

  it('warn — cred.dir diverges from binding.vaultDir', async () => {
    const fs = new MemoryFilesystem();
    const altVault = `${HOMEDIR}/.chamba/vaults/alt-vault`;
    // Workspace binding points to DEFAULT_VAULT
    await writeWorkspaceBinding(fs, WSROOT, SLUG, DEFAULT_VAULT);
    // Create DEFAULT_VAULT
    await fs.mkdir(`${DEFAULT_VAULT}/.obsidian`);
    await fs.writeFile(`${DEFAULT_VAULT}/.obsidian/app.json`, '{}');
    // Cred points to a different dir
    await writeCred(fs, SLUG, altVault);
    // Create altVault so it exists
    await fs.mkdir(altVault);

    const report = await runDoctor(
      makeInput(fs, { workspaceRoot: WSROOT, workspaceRootSource: 'cwd' }),
    );
    const check = parcheCheck(report.checks);
    expect(check?.status).toBe('warn');
  });

  it('AC5 — CHAMBA_OBSIDIAN_VAULT_PATH differs from workspace vault → warn mentioning it', async () => {
    const fs = new MemoryFilesystem();
    // Workspace binding + cred + vault dir all aligned
    await writeWorkspaceBinding(fs, WSROOT, SLUG, DEFAULT_VAULT);
    await fs.mkdir(`${DEFAULT_VAULT}/.obsidian`);
    await fs.writeFile(`${DEFAULT_VAULT}/.obsidian/app.json`, '{}');
    await writeCred(fs, SLUG, DEFAULT_VAULT);

    // CHAMBA_OBSIDIAN_VAULT_PATH points to a different vault
    const otherVault = `${HOMEDIR}/other-obsidian-vault`;
    await fs.mkdir(`${otherVault}/.obsidian`);
    await fs.writeFile(`${otherVault}/.obsidian/app.json`, '{}');

    const report = await runDoctor(
      makeInput(fs, {
        workspaceRoot: WSROOT,
        workspaceRootSource: 'cwd',
        obsidianVaultPath: otherVault,
      }),
    );
    const check = parcheCheck(report.checks);
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('CHAMBA_OBSIDIAN_VAULT_PATH');
  });

  it('O3 — workspace source "env" shown in detail when workspaceRootSource:env', async () => {
    const fs = new MemoryFilesystem();
    // Workspace binding + cred + vault dir aligned
    await writeWorkspaceBinding(fs, WSROOT, SLUG, DEFAULT_VAULT);
    await fs.mkdir(`${DEFAULT_VAULT}/.obsidian`);
    await fs.writeFile(`${DEFAULT_VAULT}/.obsidian/app.json`, '{}');
    await writeCred(fs, SLUG, DEFAULT_VAULT);

    const report = await runDoctor(
      makeInput(fs, { workspaceRoot: WSROOT, workspaceRootSource: 'env' }),
    );
    const check = parcheCheck(report.checks);
    expect(check?.status).toBe('ok');
    expect(check?.detail).toContain('env');
  });

  it('O3 — no workspace detected → detail says fallback from cwd', async () => {
    const fs = new MemoryFilesystem();
    // No binding at all, no workspace
    const cwd = `${HOMEDIR}/Projects/foo`;
    const report = await runDoctor(makeInput(fs, { cwd }));
    const check = parcheCheck(report.checks);
    expect(check?.status).toBe('ok');
    // Should mention that it uses global/detección because no workspace was found from cwd
    expect(check?.detail).toContain(cwd);
  });

  it('O3 — global binding used shows "global" in detail', async () => {
    const fs = new MemoryFilesystem();
    const cwd = `${HOMEDIR}/Projects/foo`;
    await writeGlobalBinding(fs, SLUG);

    const report = await runDoctor(makeInput(fs, { cwd }));
    const check = parcheCheck(report.checks);
    expect(check).toBeDefined();
    // Global binding without cred → warn
    expect(check?.status).toBe('warn');
    expect(check?.detail).toContain('global');
  });
});
