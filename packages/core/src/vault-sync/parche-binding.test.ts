/**
 * parche-binding.test.ts — PARCHE-011 tests for parcheBindingFileSchema,
 * findWorkspaceRoot, resolveParcheBinding, readParcheBinding, writeParcheBinding.
 *
 * All I/O uses MemoryFilesystem — no real HOME/~/.chamba.
 */

import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import {
  findWorkspaceRoot,
  parcheBindingFileSchema,
  readParcheBinding,
  resolveParcheBinding,
  writeParcheBinding,
} from './parche-binding.js';

// ─── Schema validation ────────────────────────────────────────────────────────

describe('parcheBindingFileSchema', () => {
  const valid = {
    version: 1 as const,
    server: 'https://parche.chamba.tools',
    slug: 'team-alpha',
    vaultDir: '/abs/vault',
  };

  it('accepts a minimal valid object', () => {
    const result = parcheBindingFileSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects version 2', () => {
    const result = parcheBindingFileSchema.safeParse({ ...valid, version: 2 });
    expect(result.success).toBe(false);
  });

  it('rejects unknown key "token"', () => {
    const result = parcheBindingFileSchema.safeParse({ ...valid, token: 'pch_abc' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown key "code"', () => {
    const result = parcheBindingFileSchema.safeParse({ ...valid, code: 'K7QX-M2RP' });
    expect(result.success).toBe(false);
  });

  it('rejects arbitrary unknown keys', () => {
    const result = parcheBindingFileSchema.safeParse({ ...valid, randomKey: true });
    expect(result.success).toBe(false);
  });

  it('rejects non-https server (http://evil.com)', () => {
    const result = parcheBindingFileSchema.safeParse({ ...valid, server: 'http://evil.com' });
    expect(result.success).toBe(false);
  });

  it('accepts http://localhost loopback', () => {
    const result = parcheBindingFileSchema.safeParse({ ...valid, server: 'http://localhost:4000' });
    expect(result.success).toBe(true);
  });

  it('defaults autoSync when absent', () => {
    const result = parcheBindingFileSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.autoSync.enabled).toBe(true);
      expect(result.data.autoSync.pullTtlMin).toBe(5);
    }
  });
});

// ─── readParcheBinding + relative vaultDir resolution ────────────────────────

describe('readParcheBinding', () => {
  it('returns missing:true when file does not exist', async () => {
    const fs = new MemoryFilesystem();
    const result = await readParcheBinding(fs, '/home/test/.chamba/parche.json', {
      scope: 'global',
      baseDir: '/home/test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toBe(true);
  });

  it('resolves relative vaultDir against baseDir', async () => {
    const fs = new MemoryFilesystem();
    await fs.mkdir('/workspace/.chamba');
    await fs.writeFile(
      '/workspace/.chamba/parche.json',
      JSON.stringify({
        version: 1,
        server: 'https://parche.chamba.tools',
        slug: 'team-alpha',
        vaultDir: 'vault',
      }),
    );
    const result = await readParcheBinding(fs, '/workspace/.chamba/parche.json', {
      scope: 'workspace',
      baseDir: '/workspace',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.binding.vaultDir).toBe('/workspace/vault');
    }
  });

  it('keeps absolute vaultDir as-is', async () => {
    const fs = new MemoryFilesystem();
    await fs.mkdir('/workspace/.chamba');
    await fs.writeFile(
      '/workspace/.chamba/parche.json',
      JSON.stringify({
        version: 1,
        server: 'https://parche.chamba.tools',
        slug: 'team-alpha',
        vaultDir: '/other/abs/vault',
      }),
    );
    const result = await readParcheBinding(fs, '/workspace/.chamba/parche.json', {
      scope: 'workspace',
      baseDir: '/workspace',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.binding.vaultDir).toBe('/other/abs/vault');
    }
  });

  it('returns error when file is not valid JSON', async () => {
    const fs = new MemoryFilesystem({ '/home/test/.chamba/parche.json': 'not json{{' });
    const result = await readParcheBinding(fs, '/home/test/.chamba/parche.json', {
      scope: 'global',
      baseDir: '/home/test',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toBeFalsy();
  });
});

// ─── writeParcheBinding round-trip ────────────────────────────────────────────

describe('writeParcheBinding', () => {
  it('round-trips content through write + readFile + parse', async () => {
    const fs = new MemoryFilesystem();
    const file = {
      version: 1 as const,
      server: 'https://parche.chamba.tools',
      slug: 'team-alpha',
      vaultDir: 'vault',
      autoSync: { enabled: true, pullTtlMin: 5 },
    };
    const path = '/workspace/.chamba/parche.json';
    await writeParcheBinding(fs, path, file);

    const raw = await fs.readFile(path);
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({
      version: 1,
      server: 'https://parche.chamba.tools',
      slug: 'team-alpha',
      vaultDir: 'vault',
      autoSync: { enabled: true, pullTtlMin: 5 },
    });
  });
});

// ─── findWorkspaceRoot ────────────────────────────────────────────────────────

describe('findWorkspaceRoot', () => {
  // Workspace paths inside homedir (realistic case)
  const HOME = '/home/test';

  it('finds root from a subdirectory (inside homedir)', async () => {
    const fs = new MemoryFilesystem();
    await fs.mkdir(`${HOME}/Projects/my-project/.chamba`);
    await fs.writeFile(`${HOME}/Projects/my-project/.chamba/workspace.md`, '# Workspace\n');

    const root = await findWorkspaceRoot(fs, `${HOME}/Projects/my-project/src/deep`, HOME);
    expect(root).toBe(`${HOME}/Projects/my-project`);
  });

  it('finds root from the workspace dir itself', async () => {
    const fs = new MemoryFilesystem();
    await fs.mkdir(`${HOME}/Projects/my-project/.chamba`);
    await fs.writeFile(`${HOME}/Projects/my-project/.chamba/workspace.md`, '# Workspace\n');

    const root = await findWorkspaceRoot(fs, `${HOME}/Projects/my-project`, HOME);
    expect(root).toBe(`${HOME}/Projects/my-project`);
  });

  it('returns null when no workspace.md exists anywhere', async () => {
    const fs = new MemoryFilesystem();
    const root = await findWorkspaceRoot(fs, `${HOME}/Projects/foo`, HOME);
    expect(root).toBeNull();
  });

  it('NEVER returns homedir even when <home>/.chamba/workspace.md exists and cwd is <home>/Projects/foo', async () => {
    const fs = new MemoryFilesystem();
    // Home has workspace.md — should NOT be returned
    await fs.mkdir(`${HOME}/.chamba`);
    await fs.writeFile(`${HOME}/.chamba/workspace.md`, '# Home "workspace"\n');

    const root = await findWorkspaceRoot(fs, `${HOME}/Projects/foo`, HOME);
    expect(root).toBeNull();
  });

  it('NEVER returns homedir even when <home>/.chamba/parche.json exists (only workspace.md is marker)', async () => {
    const fs = new MemoryFilesystem();
    await fs.mkdir(`${HOME}/.chamba`);
    await fs.writeFile(
      `${HOME}/.chamba/parche.json`,
      JSON.stringify({
        version: 1,
        server: 'https://parche.chamba.tools',
        slug: 'global-team',
        vaultDir: 'vault',
      }),
    );

    const root = await findWorkspaceRoot(fs, `${HOME}/Projects/foo`, HOME);
    expect(root).toBeNull();
  });

  it('finds workspace above cwd but below homedir', async () => {
    const fs = new MemoryFilesystem();
    await fs.mkdir(`${HOME}/Projects/my-project/.chamba`);
    await fs.writeFile(`${HOME}/Projects/my-project/.chamba/workspace.md`, '# WS\n');

    const root = await findWorkspaceRoot(fs, `${HOME}/Projects/my-project/packages/core/src`, HOME);
    expect(root).toBe(`${HOME}/Projects/my-project`);
  });

  // ── Tests for workspace OUTSIDE homedir (post-fix: path-depth heuristic removed) ──

  it('finds workspace at /workspace with homedir /home/test (cwd outside homedir)', async () => {
    const fs = new MemoryFilesystem();
    await fs.mkdir('/workspace/.chamba');
    await fs.writeFile('/workspace/.chamba/workspace.md', '# External workspace\n');

    const root = await findWorkspaceRoot(fs, '/workspace/src/deep', '/home/test');
    expect(root).toBe('/workspace');
  });

  it('finds workspace at /Volumes/x/ws with homedir /home/test', async () => {
    const fs = new MemoryFilesystem();
    await fs.mkdir('/Volumes/x/ws/.chamba');
    await fs.writeFile('/Volumes/x/ws/.chamba/workspace.md', '# WS\n');

    const root = await findWorkspaceRoot(fs, '/Volumes/x/ws/pkg', '/home/test');
    expect(root).toBe('/Volumes/x/ws');
  });

  it('returns null when no workspace.md from /workspace with homedir /home/test', async () => {
    const fs = new MemoryFilesystem();
    // No marker anywhere
    const root = await findWorkspaceRoot(fs, '/workspace/src', '/home/test');
    expect(root).toBeNull();
  });
});

// ─── resolveParcheBinding ─────────────────────────────────────────────────────

describe('resolveParcheBinding', () => {
  const SERVER = 'https://parche.chamba.tools';
  const HOME = '/home/test';

  async function writeBinding(fs: MemoryFilesystem, root: string, slug: string): Promise<void> {
    await fs.mkdir(`${root}/.chamba`);
    await fs.writeFile(
      `${root}/.chamba/parche.json`,
      JSON.stringify({ version: 1, server: SERVER, slug, vaultDir: 'vault' }),
    );
  }

  it('workspace binding wins over global (AC7) — workspace inside homedir', async () => {
    const fs = new MemoryFilesystem();
    const wsRoot = `${HOME}/Projects/my-project`;
    // Workspace marker
    await fs.mkdir(`${wsRoot}/.chamba`);
    await fs.writeFile(`${wsRoot}/.chamba/workspace.md`, '# WS\n');
    await writeBinding(fs, wsRoot, 'workspace-slug');
    // Global
    await writeBinding(fs, HOME, 'global-slug');

    const binding = await resolveParcheBinding({ fs }, { cwd: `${wsRoot}/src`, homedir: HOME });
    expect(binding).not.toBeNull();
    expect(binding?.slug).toBe('workspace-slug');
    expect(binding?.scope).toBe('workspace');
  });

  it('falls back to global when no workspace is found (AC7)', async () => {
    const fs = new MemoryFilesystem();
    await writeBinding(fs, HOME, 'global-slug');

    const binding = await resolveParcheBinding(
      { fs },
      { cwd: `${HOME}/Projects/foo`, homedir: HOME },
    );
    expect(binding).not.toBeNull();
    expect(binding?.slug).toBe('global-slug');
    expect(binding?.scope).toBe('global');
  });

  it('returns null when neither workspace nor global binding exists', async () => {
    const fs = new MemoryFilesystem();
    const binding = await resolveParcheBinding(
      { fs },
      { cwd: `${HOME}/Projects/foo`, homedir: HOME },
    );
    expect(binding).toBeNull();
  });

  it('uses explicit workspaceRoot when provided (bypasses detection)', async () => {
    const fs = new MemoryFilesystem();
    const wsRoot = `${HOME}/Projects/explicit-ws`;
    // Provide wsRoot explicitly — no workspace.md needed
    await writeBinding(fs, wsRoot, 'explicit-slug');

    const binding = await resolveParcheBinding(
      { fs },
      { cwd: `${HOME}/Projects/somewhere-else`, homedir: HOME, workspaceRoot: wsRoot },
    );
    expect(binding?.slug).toBe('explicit-slug');
    expect(binding?.scope).toBe('workspace');
  });

  it('does NOT fall through to global when workspace parche.json is invalid', async () => {
    const fs = new MemoryFilesystem();
    const wsRoot = `${HOME}/Projects/my-project`;
    // Workspace marker
    await fs.mkdir(`${wsRoot}/.chamba`);
    await fs.writeFile(`${wsRoot}/.chamba/workspace.md`, '# WS\n');
    // Invalid parche.json in workspace (has unknown key)
    await fs.writeFile(
      `${wsRoot}/.chamba/parche.json`,
      JSON.stringify({ version: 1, token: 'bad', server: SERVER, slug: 'ws-bad', vaultDir: 'v' }),
    );
    // Valid global
    await writeBinding(fs, HOME, 'global-slug');

    const binding = await resolveParcheBinding({ fs }, { cwd: `${wsRoot}/src`, homedir: HOME });
    // Workspace file was invalid (unknown key) → strict rejection → no fallthrough → null
    expect(binding).toBeNull();
  });
});
