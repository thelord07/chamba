import { fileURLToPath } from 'node:url';
/**
 * installer-parche.test.ts — PARCHE-010 AC1 tests for opencode-extras installer.
 *
 * Covers:
 *   AC1 — OpencodeInstaller.install() installs /parche command (new in PARCHE-010)
 *         /vault command still installed and has expected content
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MemoryFilesystem } from '@chamba/core';
import { describe, expect, it } from 'vitest';
import { OpencodeInstaller } from './installer.js';

// Repo root: this file lives in packages/<pkg>/src/.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const REAL_ASSETS_DIR = resolve(REPO_ROOT, 'packages/opencode-extras/assets');

/**
 * Build an OpencodeInstaller with real asset file content seeded into a MemoryFilesystem.
 */
async function buildWithRealAssets() {
  const fs = new MemoryFilesystem();

  const commandFiles = [
    'orq.md',
    'ticket.md',
    'triage.md',
    'workspace.md',
    'worktrees.md',
    'recall.md',
    'vault.md',
    'parche.md',
    'qa.md',
    'map.md',
    'design.md',
  ];
  const agentFiles = [
    'planner.md',
    'implementer.md',
    'reviewer.md',
    'tester.md',
    'qa.md',
    'diagnostician.md',
  ];

  for (const name of commandFiles) {
    try {
      const content = await readFile(`${REAL_ASSETS_DIR}/commands/${name}`, 'utf-8');
      await fs.writeFile(`/assets/commands/${name}`, content);
    } catch {
      // Skip if file doesn't exist
    }
  }
  for (const name of agentFiles) {
    try {
      const content = await readFile(`${REAL_ASSETS_DIR}/agents/${name}`, 'utf-8');
      await fs.writeFile(`/assets/agents/${name}`, content);
    } catch {
      // Skip if file doesn't exist
    }
  }

  const installer = new OpencodeInstaller({
    fs,
    assetsDir: '/assets',
    opencodeDir: '/oc',
    globalConfigPath: '/home/.chamba/config.json',
  });

  return { fs, installer };
}

// ─── AC1: parche.md installed in opencode ────────────────────────────────────

describe('AC1 — opencode-extras installs /parche command', () => {
  it('parche.md asset exists at packages/opencode-extras/assets/commands/parche.md', async () => {
    const content = await readFile(
      resolve(REPO_ROOT, 'packages/opencode-extras/assets/commands/parche.md'),
      'utf-8',
    );
    // Must be byte-identical to the claude-extras canonical source (copy-assets.mjs copies it)
    const source = await readFile(
      resolve(REPO_ROOT, 'packages/claude-extras/assets/commands/parche.md'),
      'utf-8',
    );
    expect(content).toBe(source);
  });

  it('OpencodeInstaller.install() installs parche.md command', async () => {
    const { fs, installer } = await buildWithRealAssets();
    const result = await installer.install();

    expect(result.installed).toContain('commands/parche.md');
    expect(await fs.exists('/oc/commands/parche.md')).toBe(true);
  });

  it('/vault command still installed and content is non-empty', async () => {
    const { fs, installer } = await buildWithRealAssets();
    const result = await installer.install();

    expect(result.installed).toContain('commands/vault.md');
    expect(await fs.exists('/oc/commands/vault.md')).toBe(true);

    const installedVault = await fs.readFile('/oc/commands/vault.md');
    expect(installedVault.length).toBeGreaterThan(0);
  });

  it('install is idempotent: second run skips parche.md', async () => {
    const { installer } = await buildWithRealAssets();
    await installer.install();
    const second = await installer.install();

    expect(second.skipped).toContain('commands/parche.md');
    expect(second.installed).not.toContain('commands/parche.md');
  });

  it('--force reinstalls parche.md with fresh content', async () => {
    const { fs, installer } = await buildWithRealAssets();
    await installer.install();

    await fs.writeFile('/oc/commands/parche.md', 'user-edited');

    const result = await installer.install({ force: true });
    expect(result.installed).toContain('commands/parche.md');

    const installed = await fs.readFile('/oc/commands/parche.md');
    expect(installed).not.toBe('user-edited');
  });
});
