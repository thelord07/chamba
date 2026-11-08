/**
 * obsidian/knowledge/promote.ts — CHAMBA-021 S12: promote a note from
 * `estado: propuesto` to `estado: canonico`.
 *
 * NOT to be confused with `chamba_vault_topics action:'promote'` (promotes a
 * *proposed topic* to the vocabulary) — this promotes a *note*. See the tool
 * descriptions in `packages/mcp/src/tools/vault-promote.ts` and
 * `vault-topics.ts`, which spell out the distinction explicitly.
 *
 * Only `upsertNoteMetadata` is used — the body is never touched.
 * Pure TypeScript — no `node:` imports, no external dependencies.
 */

import type { FilesystemPort } from '../../ports/filesystem.js';
import { joinPath } from '../../util/path.js';
import { isDerivedPathPattern } from './derived-path.js';
import { readNoteMetadata, upsertNoteMetadata } from './note-metadata.js';
import { safeVaultRelPath } from './safe-path.js';

export interface PromoteDiffEntry {
  path: string;
  before: string;
  after: string;
}

export interface PromoteRejection {
  path: string;
  reason: string;
}

export interface PromoteNotesResult {
  diffs: PromoteDiffEntry[];
  rejected: PromoteRejection[];
}

export interface PromoteNotesApplyResult {
  written: string[];
  rejected: PromoteRejection[];
}

/**
 * Remove the top-level `flag:` scalar line from frontmatter (promoting a
 * `flag: revisar` note means a human reviewed it — the flag no longer
 * applies). `upsertNoteMetadata` has no key-deletion primitive, so this is a
 * narrow, line-level removal: only a non-indented `flag:` line, never touches
 * any other key or the body.
 */
function stripFlagLine(content: string): string {
  const lines = content.split('\n');
  const stripCR = (l: string) => (l.endsWith('\r') ? l.slice(0, -1) : l);
  if (stripCR(lines[0] ?? '') !== '---') return content;
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (stripCR(lines[i] ?? '') === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) return content;

  const fm = lines.slice(0, closeIdx);
  const rest = lines.slice(closeIdx);
  const filtered = fm.filter((l) => {
    const s = stripCR(l);
    return !(s === 'flag:' || s.startsWith('flag: '));
  });
  return [...filtered, ...rest].join('\n');
}

function extractFrontmatter(content: string): string {
  const lines = content.split('\n');
  if ((lines[0] ?? '').replace(/\r$/, '') !== '---') return '';
  const closeIdx = lines.findIndex((l, i) => i > 0 && l.replace(/\r$/, '') === '---');
  if (closeIdx === -1) return '';
  return lines.slice(0, closeIdx + 1).join('\n');
}

/**
 * Validate `rawPath`, read the note, and compute the promote patch — or a
 * rejection reason. Shared by `promoteNotesPlan` and `promoteNotesApply`.
 */
async function resolveOne(
  fs: FilesystemPort,
  vaultDir: string,
  rawPath: string,
): Promise<{ path: string; content: string } | { reason: string }> {
  const safe = safeVaultRelPath(rawPath);
  if ('error' in safe) return { reason: safe.error };

  if (isDerivedPathPattern(safe.ok)) {
    return { reason: `No se puede promover un archivo derivado: ${safe.ok}` };
  }

  const absPath = joinPath(vaultDir, safe.ok);
  let content: string;
  try {
    content = await fs.readFile(absPath);
  } catch {
    return { reason: `Archivo no encontrado: ${safe.ok}` };
  }

  return { path: safe.ok, content };
}

/**
 * Compute what `promoteNotesApply` would write, without writing anything.
 * Promoting sets `estado: canonico` and, if `flag === 'revisar'`, removes
 * `flag` (a human reviewed it). An already-canonical note is reported as a
 * no-op rejection (not an error, not a diff).
 */
export async function promoteNotesPlan(
  fs: FilesystemPort,
  vaultDir: string,
  paths: string[],
): Promise<PromoteNotesResult> {
  const diffs: PromoteDiffEntry[] = [];
  const rejected: PromoteRejection[] = [];

  for (const rawPath of paths) {
    const resolved = await resolveOne(fs, vaultDir, rawPath);
    if ('reason' in resolved) {
      rejected.push({ path: rawPath, reason: resolved.reason });
      continue;
    }

    const { path, content } = resolved;
    const meta = readNoteMetadata(content, path);
    if (meta.estado === 'canonico' || meta.estado === undefined) {
      rejected.push({ path, reason: 'La nota ya es canónica (no-op).' });
      continue;
    }

    const patch: Parameters<typeof upsertNoteMetadata>[1] = { estado: 'canonico' };
    let updated = upsertNoteMetadata(content, patch);
    if (meta.flag === 'revisar') updated = stripFlagLine(updated);

    diffs.push({ path, before: extractFrontmatter(content), after: extractFrontmatter(updated) });
  }

  return { diffs, rejected };
}

/** Apply the promotion computed by `promoteNotesPlan` — writes the files. */
export async function promoteNotesApply(
  fs: FilesystemPort,
  vaultDir: string,
  paths: string[],
): Promise<PromoteNotesApplyResult> {
  const written: string[] = [];
  const rejected: PromoteRejection[] = [];

  for (const rawPath of paths) {
    const resolved = await resolveOne(fs, vaultDir, rawPath);
    if ('reason' in resolved) {
      rejected.push({ path: rawPath, reason: resolved.reason });
      continue;
    }

    const { path, content } = resolved;
    const meta = readNoteMetadata(content, path);
    if (meta.estado === 'canonico' || meta.estado === undefined) {
      rejected.push({ path, reason: 'La nota ya es canónica (no-op).' });
      continue;
    }

    const patch: Parameters<typeof upsertNoteMetadata>[1] = { estado: 'canonico' };
    let updated = upsertNoteMetadata(content, patch);
    if (meta.flag === 'revisar') updated = stripFlagLine(updated);

    await fs.writeFile(joinPath(vaultDir, path), updated);
    written.push(path);
  }

  return { written, rejected };
}
