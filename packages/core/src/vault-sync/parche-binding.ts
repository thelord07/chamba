/**
 * vault-sync/parche-binding.ts — schema, I/O and workspace-detection for
 * `.chamba/parche.json` (per-workspace and global scopes).
 *
 * PARCHE-011: each workspace keeps its own parche binding.
 * Pure: no node: imports. All IO via FilesystemPort.
 */

import { z } from 'zod';
import type { FilesystemPort } from '../ports/filesystem.js';
import { dirname, joinPath } from '../util/path.js';
import { assertAllowedServerUrl } from './server-url.js';
import { lexicalNormalize } from './vault-dir.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const PARCHE_FILE = 'parche.json';
export const CHAMBA_DIR = '.chamba';
export const WORKSPACE_MARKER = 'workspace.md';

/** Returns the path to `<root>/.chamba/parche.json`. */
export function parcheFilePath(root: string): string {
  return joinPath(root, CHAMBA_DIR, PARCHE_FILE);
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const autoSyncSchema = z
  .object({
    enabled: z.boolean().default(true),
    pullTtlMin: z.number().int().positive().default(5),
  })
  .strict();

export const parcheBindingFileSchema = z
  .object({
    version: z.literal(1),
    server: z
      .string()
      .min(1)
      .refine(
        (u) => {
          try {
            assertAllowedServerUrl(u);
            return true;
          } catch {
            return false;
          }
        },
        { message: 'server debe ser https:// (o http:// loopback)' },
      ),
    slug: z.string().min(1),
    /** Relative to workspace root (workspace scope) or homedir (global scope), or absolute. */
    vaultDir: z.string().min(1),
    autoSync: autoSyncSchema.default({ enabled: true, pullTtlMin: 5 }),
  })
  .strict();

export type ParcheBindingFile = z.infer<typeof parcheBindingFileSchema>;
export type ParcheScope = 'workspace' | 'global';

// ─── ParcheBinding (resolved) ─────────────────────────────────────────────────

export interface ParcheBinding {
  scope: ParcheScope;
  server: string;
  slug: string;
  /** Absolute resolved path. */
  vaultDir: string;
  autoSync: { enabled: boolean; pullTtlMin: number };
  /** Path to the parche.json file on disk (for doctor/unlink/messages). */
  bindingPath: string;
  /** Workspace root (workspace scope) or homedir (global scope). */
  baseDir: string;
}

// ─── readParcheBinding ────────────────────────────────────────────────────────

export type ReadParcheBindingResult =
  | { ok: true; binding: ParcheBinding }
  | { ok: false; missing: true }
  | { ok: false; missing?: false; error: string };

/**
 * Read and parse one parche.json file. Returns:
 *   `{ ok: true, binding }` on success,
 *   `{ ok: false, missing: true }` when the file does not exist,
 *   `{ ok: false, error }` when the file exists but is invalid.
 *
 * Resolves a relative `vaultDir` against `opts.baseDir`.
 */
export async function readParcheBinding(
  fs: FilesystemPort,
  bindingPath: string,
  opts: { scope: ParcheScope; baseDir: string },
): Promise<ReadParcheBindingResult> {
  try {
    const exists = await fs.exists(bindingPath);
    if (!exists) return { ok: false, missing: true };

    const raw = await fs.readFile(bindingPath);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'archivo no es JSON válido' };
    }

    const result = parcheBindingFileSchema.safeParse(parsed);
    if (!result.success) {
      return { ok: false, error: result.error.message };
    }

    const file = result.data;

    // Resolve vaultDir: relative → absolute against baseDir
    let vaultDir = file.vaultDir;
    if (!vaultDir.startsWith('/')) {
      vaultDir = lexicalNormalize(joinPath(opts.baseDir, vaultDir));
    }

    const binding: ParcheBinding = {
      scope: opts.scope,
      server: file.server,
      slug: file.slug,
      vaultDir,
      autoSync: file.autoSync,
      bindingPath,
      baseDir: opts.baseDir,
    };

    return { ok: true, binding };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── writeParcheBinding ───────────────────────────────────────────────────────

/**
 * Write a parche.json file atomically (tmp + rename via fs.writeBytes).
 * Creates the parent directory if needed.
 */
export async function writeParcheBinding(
  fs: FilesystemPort,
  bindingPath: string,
  file: ParcheBindingFile,
): Promise<void> {
  const dir = dirname(bindingPath);
  await fs.mkdir(dir);
  const enc = new TextEncoder();
  await fs.writeBytes(bindingPath, enc.encode(JSON.stringify(file, null, 2)));
}

// ─── findWorkspaceRoot ────────────────────────────────────────────────────────

/**
 * Walk up from `cwd` and return the first directory that contains
 * `.chamba/workspace.md` (the sole workspace marker — R1). Stops before
 * accepting `homedir` as a workspace root (homedir is NEVER a workspace).
 *
 * Returns `null` when no workspace is found.
 */
export async function findWorkspaceRoot(
  fs: FilesystemPort,
  cwd: string,
  homedir?: string,
): Promise<string | null> {
  let dir = cwd.replace(/[/\\]+$/, '');
  if (dir.length === 0) dir = '/';

  for (let i = 0; i < 64; i++) {
    // Never accept homedir as a workspace root, and never walk past it: a cwd under
    // home stops there; a cwd outside home walks up to `/` without ever reaching it.
    if (homedir && dir === homedir) return null;

    const markerPath = joinPath(dir, CHAMBA_DIR, WORKSPACE_MARKER);
    if (await fs.exists(markerPath)) return dir;

    const parent = dirname(dir);
    if (parent === dir || parent === '') return null;
    dir = parent;
  }

  return null;
}

// ─── resolveParcheBinding ─────────────────────────────────────────────────────

/**
 * Resolve the active parche binding from workspace + global parche.json files.
 * Workspace binding wins over global (O2: no fallthrough once found).
 *
 * Does NOT consult CHAMBA_OBSIDIAN_VAULT_PATH or the Obsidian detector —
 * that full D3 precedence lives in resolveActiveParcheVault (mcp layer).
 */
export async function resolveParcheBinding(
  deps: { fs: FilesystemPort },
  opts: { cwd: string; homedir: string; workspaceRoot?: string },
): Promise<ParcheBinding | null> {
  const { fs } = deps;
  const { cwd, homedir, workspaceRoot } = opts;

  // Step 1: workspace binding
  const wsRoot = workspaceRoot ?? (await findWorkspaceRoot(fs, cwd, homedir));
  if (wsRoot) {
    const wsPath = parcheFilePath(wsRoot);
    const wsResult = await readParcheBinding(fs, wsPath, { scope: 'workspace', baseDir: wsRoot });
    if (wsResult.ok) return wsResult.binding;
    // If file exists but is invalid, still don't fall through to global
    if (!wsResult.missing) return null;
  }

  // Step 2: global binding
  const globalPath = parcheFilePath(homedir);
  const globalResult = await readParcheBinding(fs, globalPath, {
    scope: 'global',
    baseDir: homedir,
  });
  if (globalResult.ok) return globalResult.binding;

  return null;
}
