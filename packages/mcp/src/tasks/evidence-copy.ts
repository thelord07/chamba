/**
 * tasks/evidence-copy.ts — CHAMBA-022 (C4)
 *
 * Copies `chamba_task evidence kind='qa'` material from the agent-provided
 * `sourcePath` into the task's evidence tree, inside the budget
 * (`planEvidenceCopy`), rejecting anything outside the two allowed QA
 * evidence roots and any symlink that escapes them (N2). `report.md` gets
 * `redactSecretValues` + `secretWriteGate` before it is ever copied (B7) —
 * if the gate still blocks, the file is skipped and reported, never copied.
 *
 * "Destructivo": nothing here ever deletes — files over budget are LINKED
 * (reported, pointing at the original `sourcePath`), never dropped.
 */

import {
  basename,
  DEFAULT_EVIDENCE_BUDGET,
  detectStyle,
  dirname,
  type EvidenceBudgetLimits,
  type EvidenceFileInput,
  type EvidenceRef,
  isUnderLocal,
  joinPath,
  normalizeWorkItemId,
  planEvidenceCopy,
  redactSecretValues,
} from '@chamba/core';
import { resolveWsRoot } from '../parche/resolve-ws-root.js';
import type { Services } from '../services.js';
import { secretWriteGate } from '../write-gate.js';
import { taskEvidenceAbsDir } from './task-store.js';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg)$/i;
const MAX_WALK_DEPTH = 2;

function classifyKind(relPath: string): EvidenceFileInput['kind'] {
  if (IMAGE_EXT.test(relPath)) return 'image';
  if (relPath.toLowerCase().endsWith('.md')) return 'text';
  return 'other';
}

interface WalkedFile {
  absPath: string;
  relPath: string;
  sizeBytes: number;
}

async function walkDepthLimited(
  services: Services,
  rootAbs: string,
  dir: string,
  relDir: string,
  depth: number,
  out: WalkedFile[],
): Promise<void> {
  if (depth > MAX_WALK_DEPTH) return;
  let entries: Awaited<ReturnType<Services['fs']['readDir']>>;
  try {
    entries = await services.fs.readDir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = joinPath(dir, entry.name);
    const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      await walkDepthLimited(services, rootAbs, abs, rel, depth + 1, out);
    } else {
      // N2: a symlink entry is neither isFile nor isDirectory on Node
      // (lstat-based `readdir`) — treated as a candidate file so the
      // realpath containment check below can catch and report it, instead
      // of silently vanishing from the walk.
      const stat = await services.fs.stat(abs);
      out.push({ absPath: abs, relPath: rel, sizeBytes: stat?.size ?? 0 });
    }
  }
}

/** B5: portable containment (detectStyle + caseFoldLocal via isUnderLocal) — never a bare POSIX `startsWith('/')`. */
async function realpathUnder(
  services: Services,
  allowedRoots: string[],
  absPath: string,
): Promise<string | undefined> {
  try {
    const real = await services.fs.realpath(absPath);
    const style = detectStyle(services.platform);
    for (const root of allowedRoots) {
      if (isUnderLocal(root, real, style)) return real;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export interface CopyQaEvidenceInput {
  services: Services;
  /** Absolute, agent-provided (§9: the one path in this flow that comes from the agent). */
  sourcePath: string;
  vaultPath: string;
  workItem: string;
  runId: string;
  limits?: EvidenceBudgetLimits;
}

export type CopyQaEvidenceResult =
  | {
      ok: true;
      copied: EvidenceRef[];
      linkedOnly: EvidenceRef[];
      /** Human-readable notes (report.md retained, symlinks skipped, budget hit). */
      notes: string[];
    }
  | { ok: false; error: string };

export async function copyQaEvidence(input: CopyQaEvidenceInput): Promise<CopyQaEvidenceResult> {
  const { services, sourcePath, vaultPath, workItem, runId } = input;

  if (!sourcePath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(sourcePath)) {
    return { ok: false, error: `sourcePath debe ser una ruta absoluta: "${sourcePath}".` };
  }

  const allowedRoots = [
    joinPath(await resolveWsRoot(services), '.chamba', 'qa-evidence'),
    joinPath(services.homedir, '.chamba', 'qa-evidence'),
  ];

  const realSource = await realpathUnder(services, allowedRoots, sourcePath);
  if (!realSource) {
    return {
      ok: false,
      error: `sourcePath "${sourcePath}" no está bajo <wsRoot>/.chamba/qa-evidence/ ni <homedir>/.chamba/qa-evidence/.`,
    };
  }

  const files: WalkedFile[] = [];
  const notes: string[] = [];

  if (!(await services.fs.exists(realSource))) {
    return { ok: false, error: `sourcePath no existe: "${sourcePath}".` };
  }
  // qa.md's convention: sourcePath is always the run DIRECTORY
  // (`<evidence-root>/<ticket>/<run-date>/`), never a single file.
  await walkDepthLimited(services, realSource, realSource, '', 0, files);

  // N2: per-file realpath containment — a symlink escaping the QA root is skipped, never copied.
  const safeFiles: WalkedFile[] = [];
  for (const f of files) {
    const real = await realpathUnder(services, allowedRoots, f.absPath);
    if (!real) {
      notes.push(
        `se omitió "${f.relPath}": el symlink apunta fuera de la carpeta de evidencia QA.`,
      );
      continue;
    }
    safeFiles.push({ ...f, absPath: real });
  }

  // B7: report.md is gated on its RAW content BEFORE it is ever eligible for
  // copy (same "gate before disk" order as open/update/scope_change) — if it
  // blocks, nothing is copied. When it passes, `redactSecretValues` is still
  // applied as defense in depth before the copy (overrideContent below).
  const reportIdx = safeFiles.findIndex((f) => f.relPath.toLowerCase().endsWith('report.md'));
  let reportRetained = false;
  const overrideContent = new Map<string, string>();
  if (reportIdx !== -1) {
    const report = safeFiles[reportIdx] as WalkedFile;
    const raw = await services.fs.readFile(report.absPath);
    const gate = await secretWriteGate(services.hash, [{ field: 'report.md', value: raw }]);
    if (gate.blocked) {
      reportRetained = true;
      notes.push(`report.md retenido: el escáner detectó hallazgos.`);
      safeFiles.splice(reportIdx, 1);
    } else {
      overrideContent.set(report.relPath, redactSecretValues(raw));
    }
  }

  const budgetInputs: EvidenceFileInput[] = safeFiles.map((f) => ({
    path: f.relPath,
    sizeBytes: f.sizeBytes,
    kind: classifyKind(f.relPath),
  }));
  const plan = planEvidenceCopy(budgetInputs, input.limits ?? DEFAULT_EVIDENCE_BUDGET);

  const destDir = joinPath(taskEvidenceAbsDir(vaultPath, workItem, runId), 'qa');
  const copy = new Set(plan.copy.map((f) => f.path));

  const copied: EvidenceRef[] = [];
  const linkedOnly: EvidenceRef[] = [];

  for (const f of safeFiles) {
    if (!copy.has(f.relPath)) continue;
    const destAbs = joinPath(destDir, f.relPath);
    await services.fs.mkdir(dirname(destAbs));
    const override = overrideContent.get(f.relPath);
    const bytes =
      override !== undefined
        ? new TextEncoder().encode(override)
        : await services.fs.readBytes(f.absPath);
    await services.fs.writeBytes(destAbs, bytes);
    const vaultRel = joinPath(
      'tareas',
      normalizeWorkItemId(workItem),
      'evidencia',
      runId,
      'qa',
      f.relPath,
    );
    copied.push({ path: vaultRel, kind: 'qa' });
  }

  for (const entry of plan.linkOnly) {
    notes.push(`"${entry.path}": ${entry.reason} — se enlaza sin copiar.`);
    // NB-3 (round 2 review): NEVER persist the user's absolute local disk
    // path into a note that gets synced to the whole team — a non-
    // identifying `local:<filename>` reference is enough for the author to
    // find it again on their own machine; the reason ("excede el
    // presupuesto, quedó en tu disco") is rendered alongside it
    // (task-doc.ts's `renderEvidenceBlock`).
    linkedOnly.push({ path: `local:${basename(entry.path)}`, kind: 'qa', linkOnly: true });
  }

  void reportRetained; // already reflected in `notes` and the missing copy entry

  return { ok: true, copied, linkedOnly, notes };
}
