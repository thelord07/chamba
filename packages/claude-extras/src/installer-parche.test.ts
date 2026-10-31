import { fileURLToPath } from 'node:url';
/**
 * installer-parche.test.ts — PARCHE-010 AC1 tests for claude-extras installer.
 *
 * Covers:
 *   AC1 — Installer.install() installs /parche command (new in PARCHE-010)
 *         /vault command still installed and still has expected content
 *         parche.md asset exists at the expected path
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MemoryFilesystem } from '@chamba/core';
import { describe, expect, it } from 'vitest';
import { Installer } from './installer.js';

// Repo root: this file lives in packages/<pkg>/src/.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const REAL_ASSETS_DIR = resolve(REPO_ROOT, 'packages/claude-extras/assets');

/**
 * Build an Installer with all real asset file content seeded into a MemoryFilesystem.
 * We read the actual asset files so the test exercises the real installer paths.
 */
async function buildWithRealAssets() {
  const fs = new MemoryFilesystem();

  // Read actual command files from disk and seed into MemoryFilesystem
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
  const hookFiles = ['PreToolUse-warn-destructive.sh', 'PostToolUse-validate-worktree.sh'];

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
  for (const name of hookFiles) {
    try {
      const content = await readFile(`${REAL_ASSETS_DIR}/hooks/${name}`, 'utf-8');
      await fs.writeFile(`/assets/hooks/${name}`, content);
    } catch {
      // Skip if file doesn't exist
    }
  }

  // Ensure .claude.json exists so installer detects Claude Code
  await fs.writeFile('/home/.claude.json', '{}');

  const installer = new Installer({
    fs,
    assetsDir: '/assets',
    claudeDir: '/home/.claude',
    claudeJsonPath: '/home/.claude.json',
    globalConfigPath: '/home/.chamba/config.json',
  });

  return { fs, installer };
}

// ─── AC1: parche.md installed ─────────────────────────────────────────────────

describe('AC1 — claude-extras installs /parche command', () => {
  it('parche.md asset exists at packages/claude-extras/assets/commands/parche.md', async () => {
    const content = await readFile(
      resolve(REPO_ROOT, 'packages/claude-extras/assets/commands/parche.md'),
      'utf-8',
    );
    expect(content.length).toBeGreaterThan(0);
    // Must have frontmatter with description
    expect(content).toContain('description:');
  });

  it('Installer.install() installs parche.md command', async () => {
    const { fs, installer } = await buildWithRealAssets();
    const result = await installer.install();

    expect(result.installed).toContain('commands/parche.md');
    expect(await fs.exists('/home/.claude/commands/parche.md')).toBe(true);
  });

  it('/vault command still installed and source unchanged', async () => {
    const { fs, installer } = await buildWithRealAssets();
    const result = await installer.install();

    expect(result.installed).toContain('commands/vault.md');
    expect(await fs.exists('/home/.claude/commands/vault.md')).toBe(true);

    // Vault content is byte-identical to the asset source
    const installedVault = await fs.readFile('/home/.claude/commands/vault.md');
    const sourceVault = await readFile(
      resolve(REPO_ROOT, 'packages/claude-extras/assets/commands/vault.md'),
      'utf-8',
    );
    expect(installedVault).toBe(sourceVault);
  });

  it('install is idempotent: second run skips parche.md', async () => {
    const { installer } = await buildWithRealAssets();
    await installer.install();
    const second = await installer.install();

    // parche.md should be in skipped, not installed
    expect(second.skipped).toContain('commands/parche.md');
    expect(second.installed).not.toContain('commands/parche.md');
  });

  it('--force reinstalls parche.md', async () => {
    const { fs, installer } = await buildWithRealAssets();
    await installer.install();

    // Overwrite parche.md
    await fs.writeFile('/home/.claude/commands/parche.md', 'user-edited');

    const result = await installer.install({ force: true });
    expect(result.installed).toContain('commands/parche.md');

    // Content restored to original
    const installed = await fs.readFile('/home/.claude/commands/parche.md');
    expect(installed).not.toBe('user-edited');
    expect(installed).toContain('description:');
  });
});
