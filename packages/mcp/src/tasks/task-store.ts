/**
 * tasks/task-store.ts — CHAMBA-022 (C1)
 *
 * Resolves the vault for `chamba_task`, reads/writes the task document
 * directly (D-2: NEVER through `VaultWriter` — it can't produce
 * `tareas/<id>.md` and reindexes on every write), and reindexes explicitly
 * only from `open`/`close` (hot-path mitigation).
 *
 * `taskMutex` (D-9): a dedicated per-process mutex, never the same map as
 * `metricsMutex`/`vaultMutex` — `withVaultLock` is not reentrant, so a
 * handler holding `taskMutex` must release it before ever touching
 * `metricsMutex` (close's `taskEvidence` write) or `vaultMutex` (autosync).
 */

import {
  controlledBlocksDigestInput,
  dirname,
  isInvalidPath,
  joinPath,
  normalizeWorkItemId,
  ObsidianDetector,
  type ParseTaskDocResult,
  parseTaskDoc,
  renderTaskDoc,
  type TaskDoc,
  taskEvidenceRelDir,
  taskNoteRelPath,
  upsertNoteMetadata,
  VaultReindexer,
} from '@chamba/core';
import type { Logger } from 'pino';
import { resolveActiveParcheVaultFull } from '../parche/active-vault.js';
import { resolveAuthor } from '../parche/provenance.js';
import { obsidianSearchRoots, type Services } from '../services.js';

// ─── Vault resolution (O6) ─────────────────────────────────────────────────

export interface TaskVaultResolution {
  vaultPath?: string;
  /** Present when no vault could be resolved — O6 degrade message. */
  reason?: string;
}

/**
 * Resolve the vault `chamba_task` should write to. Mirrors
 * `summarize-to-vault.ts`'s precedence (parche binding → env → Obsidian
 * detection) but NEVER errors: O6 says `chamba_task` degrades gracefully
 * when no vault is configured — `verify`/`close` still evaluate what they
 * have, they just can't persist a document.
 */
export async function resolveTaskVault(services: Services): Promise<TaskVaultResolution> {
  const vaultResult = await resolveActiveParcheVaultFull(services);

  if (vaultResult.kind === 'ok') return { vaultPath: vaultResult.vault.vaultDir };
  if (vaultResult.kind === 'bound-unsyncable' && vaultResult.dirExists) {
    return { vaultPath: vaultResult.vaultDir };
  }
  if (vaultResult.kind === 'bound-unsyncable') {
    return { reason: `vault vinculado pero no sincronizable: ${vaultResult.hint}` };
  }

  const detection = await new ObsidianDetector(services.fs).detect({
    explicitPath: services.obsidianVaultPath,
    searchRoots: obsidianSearchRoots(services),
  });
  if (detection.found) return { vaultPath: detection.path };

  return {
    reason:
      'sin vault: la tarea no quedó registrada. Configurá CHAMBA_OBSIDIAN_VAULT_PATH o un vault de parche.',
  };
}

// ─── Mutex (D-9) ────────────────────────────────────────────────────────────

export function getTaskMutex(services: Services): Map<string, Promise<void>> {
  if (!services.taskMutex) services.taskMutex = new Map();
  return services.taskMutex;
}

export function taskLockKey(vaultPath: string, workItem: string): string {
  return `task|${vaultPath}|${normalizeWorkItemId(workItem)}`;
}

// ─── Work-item filename validation (N3) ────────────────────────────────────

export type WorkItemPathResult = { ok: true; rel: string } | { ok: false; error: string };

/** `taskNoteRelPath` + `isInvalidPath(rel, 'win32')` (N3: double validation). */
export function validateTaskNotePath(workItem: string): WorkItemPathResult {
  const rel = taskNoteRelPath(workItem);
  if (isInvalidPath(rel, 'win32')) {
    return {
      ok: false,
      error: `el id de tarea "${workItem}" produce una ruta de archivo inválida; usá solo caracteres alfanuméricos, puntos y guiones.`,
    };
  }
  return { ok: true, rel };
}

// ─── Read ───────────────────────────────────────────────────────────────────

export type ReadTaskDocResult =
  | { found: true; doc: TaskDoc; integrityViolation?: boolean }
  | { found: false }
  | { error: string };

export interface ReadTaskDocOptions {
  /**
   * N1: when `true` (default), a digest mismatch on the chamba-controlled
   * blocks (criteria/evidence/scope changes — see `controlledBlocksDigestInput`)
   * is a hard `{error}` — the mutating actions (`update`/`scope_change`/
   * `verify`/`close`) must never act on a hand-edited document. `get` passes
   * `false` and surfaces the violation as a flag instead (`integrityViolation`),
   * since it only reads and reports, it doesn't need to block.
   */
  enforceIntegrity?: boolean;
}

/** N1: digest of the blocks chamba exclusively controls, `services.hash` is the injected port (core stays sync/pure). */
async function computeControlledBlocksDigest(services: Services, doc: TaskDoc): Promise<string> {
  const input = controlledBlocksDigestInput(doc);
  return services.hash.sha256(new TextEncoder().encode(input));
}

export async function readTaskDoc(
  services: Services,
  vaultPath: string,
  workItem: string,
  opts: ReadTaskDocOptions = {},
): Promise<ReadTaskDocResult> {
  const validated = validateTaskNotePath(workItem);
  if (!validated.ok) return { error: validated.error };

  const absPath = joinPath(vaultPath, validated.rel);
  let exists: boolean;
  try {
    exists = await services.fs.exists(absPath);
  } catch (err) {
    return { error: `no se pudo leer ${validated.rel}: ${describeErr(err)}` };
  }
  if (!exists) return { found: false };

  let raw: string;
  try {
    raw = await services.fs.readFile(absPath);
  } catch (err) {
    return { error: `no se pudo leer ${validated.rel}: ${describeErr(err)}` };
  }

  const parsed: ParseTaskDocResult = parseTaskDoc(raw);
  if ('error' in parsed) return { error: `${validated.rel}: ${parsed.error}` };

  // N1: a document written before this feature (or never re-written since)
  // has no `chamba_digest` — don't flag it; the next write stamps one.
  if (parsed.storedDigest !== undefined) {
    const expected = await computeControlledBlocksDigest(services, parsed.doc);
    if (expected !== parsed.storedDigest) {
      const msg =
        'el documento de la tarea fue editado a mano en bloques que gestiona chamba ' +
        '(criterios de aceptación, evidencia/verify, cambios de alcance); usá update/' +
        'scope_change/verify para registrar el cambio, o revertí la edición manual.';
      if (opts.enforceIntegrity === false) {
        return { found: true, doc: parsed.doc, integrityViolation: true };
      }
      return { error: msg };
    }
  }

  return { found: true, doc: parsed.doc };
}

// ─── Write (D-2: direct fs write + upsertNoteMetadata, never VaultWriter) ──

export interface WriteTaskDocOptions {
  date: string;
  author?: string;
  agentVersion?: string;
  writtenAt: string;
}

export async function writeTaskDoc(
  services: Services,
  vaultPath: string,
  doc: TaskDoc,
  opts: WriteTaskDocOptions,
): Promise<void> {
  const validated = validateTaskNotePath(doc.workItem);
  if (!validated.ok) throw new Error(validated.error);

  const absPath = joinPath(vaultPath, validated.rel);
  await services.fs.mkdir(dirname(absPath));

  // N1: stamp a digest of the chamba-controlled blocks as they stand AFTER
  // this write — `readTaskDoc` recomputes it on the next read and rejects a
  // hand-edit of criteria/evidence/scope-changes in between.
  const digest = await computeControlledBlocksDigest(services, doc);
  const rendered = renderTaskDoc(doc, { date: opts.date, digest });
  // CHAMBA-021 provenance (author/agent/written_at) — renderTaskDoc already
  // writes title/date/type/work_item/estado/estado_tarea/ruta; this patches
  // only the provenance keys on top, surgically (upsertNoteMetadata touches
  // nothing else).
  const withProvenance = upsertNoteMetadata(rendered, {
    ...(opts.author ? { author: opts.author } : {}),
    agent: `chamba/task@${opts.agentVersion ?? 'unknown'}`,
    written_at: opts.writtenAt,
  });

  await services.fs.writeBytes(absPath, new TextEncoder().encode(withProvenance));
}

/** Resolve the provenance `author` the same way `summarize_to_vault` does. */
export async function resolveTaskAuthor(
  services: Services,
  vaultResult?: Awaited<ReturnType<typeof resolveActiveParcheVaultFull>>,
): Promise<string | undefined> {
  return resolveAuthor(services, vaultResult);
}

// ─── Reindex (D-2: explicit, only from open/close) ─────────────────────────

/** Best-effort reindex — never throws, never blocks the caller's result. */
export async function reindexTaskVault(
  services: Services,
  vaultPath: string,
  logger: Logger,
): Promise<void> {
  try {
    await new VaultReindexer(services.fs, vaultPath).reindex();
  } catch (err) {
    logger.warn({ tool: 'chamba_task', err: describeErr(err) }, 'reindex falló (best-effort)');
  }
}

// ─── Evidence run ids (D-7) ─────────────────────────────────────────────────

/**
 * Generate a collision-free `run-<YYYYMMDD>-<nn>` id (D-7 — chamba, never
 * the agent, generates this; it becomes the ONLY variable segment of an
 * evidence destination path). Without a vault (nothing to collide with),
 * falls back to `-01` directly.
 */
export async function generateRunId(
  services: Services,
  vaultPath: string | undefined,
  workItem: string,
  date: string,
): Promise<string> {
  const datePart = date.replace(/-/g, '');
  const prefix = `run-${datePart}-`;
  if (!vaultPath) return `${prefix}01`;

  const dir = joinPath(vaultPath, 'tareas', normalizeWorkItemId(workItem), 'evidencia');
  let existing: string[] = [];
  try {
    existing = (await services.fs.readDir(dir)).filter((e) => e.isDirectory).map((e) => e.name);
  } catch {
    // directory doesn't exist yet — first run of the task
  }
  const nums = existing
    .filter((n) => n.startsWith(prefix))
    .map((n) => Number(n.slice(prefix.length)))
    .filter((n) => Number.isInteger(n) && n > 0);
  const next = (nums.length > 0 ? Math.max(...nums) : 0) + 1;
  return `${prefix}${String(next).padStart(2, '0')}`;
}

/** Vault-absolute directory for a run's evidence (wraps `taskEvidenceRelDir`). */
export function taskEvidenceAbsDir(vaultPath: string, workItem: string, runId: string): string {
  return joinPath(vaultPath, taskEvidenceRelDir(workItem, runId));
}

function describeErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
