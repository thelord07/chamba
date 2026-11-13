/**
 * tools/task.ts — CHAMBA-022 (C2/C5)
 *
 * `chamba_task`: open|update|scope_change|evidence|verify|close|get. A
 * single REGISTERED `z.object({...}).strict()` (never a union — the SDK
 * would publish `EMPTY_OBJECT_JSON_SCHEMA` in `listTools` otherwise), with
 * per-action internal schemas that are NOT `.strict()` — exactly the
 * pattern in `tools/task-metrics.ts`.
 *
 * D-1: the vault document is the source of truth; `chamba_task` never uses
 * `VaultWriter` (D-2) and only reindexes from `open`/`close` (hot-path).
 * D-9: `taskMutex` → close's own `taskEvidence` write uses `metricsMutex`
 * directly (inflight-store, never nested, never via `chamba_task_metrics`).
 */

import type { ReposConfig } from '@chamba/core';
import {
  type AcceptanceCriterion,
  applyScopeChange,
  assignAcIds,
  type ChecklistItem,
  type CloseGateInput,
  caseFoldLocal,
  computeNextStep,
  detectGitRepos,
  detectStyle,
  evaluateCloseGate,
  isUnderLocal,
  joinPath,
  localBasename,
  normalizeWorkItemId,
  parseChambaConfig,
  reposWithVerifyConfigured,
  type ScopeChangeEntry,
  type TaskDoc,
  type VerifyRun,
  type VerifyRunCommandResult,
  WORK_ITEM_REGEX,
  WORKSPACE_DIR,
  wrapVaultData,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  getMutex,
  listInflightIds,
  lockKey,
  readInflight,
  writeInflight,
} from '../metrics/inflight-store.js';
import { withVaultLock } from '../parche/mutex.js';
import { resolveWsRoot } from '../parche/resolve-ws-root.js';
import type { Services } from '../services.js';
import { copyQaEvidence } from '../tasks/evidence-copy.js';
import {
  generateRunId,
  getTaskMutex,
  readTaskDoc,
  reindexTaskVault,
  resolveTaskAuthor,
  resolveTaskVault,
  taskLockKey,
  validateTaskNotePath,
  writeTaskDoc,
} from '../tasks/task-store.js';
import { renderOutcomeEvidence, runVerify } from '../tasks/verify-runner.js';
import { secretWriteGate } from '../write-gate.js';

const TOOL_NAME = 'chamba_task';
const CONFIG_FILE = `${WORKSPACE_DIR}/config.json`;

const DESCRIPTION =
  'Documento de tarea vivo en el vault + cierre con evidencia real. Acciones: ' +
  'open (crea el documento, idempotente), update (progreso/siguiente paso/checklist/estado de AC — ' +
  'nunca cambia el texto de un AC ni lo descarta), scope_change (add|reopen|discard — única vía a ' +
  '«descartado», exige reason y requestedByUser en discard), evidence (copia evidencia QA con límites), ' +
  'verify (corre los comandos configurados en repos.<repo>.verify), close (compuerta: no cierra sin ' +
  'evidencia real, salvo partial+approvedByUser), get (estado + siguiente paso + worktreePath, para resume).';

// ─── Shared sub-schemas ─────────────────────────────────────────────────────

const workItemSchema = z
  .string()
  .regex(WORK_ITEM_REGEX, 'workItem debe ser un identificador (ej: CHAMBA-022).');
const acIdSchema = z.string().regex(/^AC-\d{1,2}$/, 'acId debe tener la forma AC-n.');
const repoNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, 'nombre de repo inválido.');
const routeSchema = z.enum(['trivial', 'small', 'substantial', 'risky']);
const checklistItemSchema = z.object({ text: z.string().max(200), done: z.boolean() });
const acUpdateEstadoSchema = z.enum(['pendiente', 'pasa', 'falla', 'descartado']);
const acUpdateSchema = z.object({
  id: acIdSchema,
  estado: acUpdateEstadoSchema,
  evidence: z.array(z.string()).optional(),
  reason: z.string().max(300).optional(),
});

// ─── Per-action internal schemas (NOT .strict() — see task-metrics.ts) ─────

const openInputSchema = z.object({
  action: z.literal('open'),
  workItem: workItemSchema,
  route: routeSchema,
  title: z.string().max(120).optional(),
  request: z.string().max(4000).optional(),
  criteria: z.array(z.string().max(300)).min(1).max(20).optional(),
  worktreePath: z.string().optional(),
  repos: z.array(repoNameSchema).min(1).max(10).optional(),
});

const updateInputSchema = z
  .object({
    action: z.literal('update'),
    workItem: workItemSchema,
    progress: z.string().max(500).optional(),
    nextStep: z.string().max(300).optional(),
    checklist: z.array(checklistItemSchema).max(30).optional(),
    acUpdates: z.array(acUpdateSchema).optional(),
  })
  .superRefine((value, ctx) => {
    for (const [i, upd] of (value.acUpdates ?? []).entries()) {
      if (upd.estado === 'descartado') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            "«descartado» solo se alcanza con action='scope_change' change='discard', que exige reason y requestedByUser.",
          path: ['acUpdates', i, 'estado'],
        });
      }
    }
  });

const scopeChangeInputSchema = z
  .object({
    action: z.literal('scope_change'),
    workItem: workItemSchema,
    change: z.enum(['add', 'reopen', 'discard']),
    acId: acIdSchema.optional(),
    text: z.string().max(300).optional(),
    reason: z.string().max(300).optional(),
    requestedByUser: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.change === 'add' && !value.text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "'add' requiere 'text'.",
        path: ['text'],
      });
    }
    if ((value.change === 'reopen' || value.change === 'discard') && !value.acId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `'${value.change}' requiere 'acId'.`,
        path: ['acId'],
      });
    }
  });

const evidenceInputSchema = z.object({
  action: z.literal('evidence'),
  workItem: workItemSchema,
  kind: z.enum(['qa', 'manual']),
  sourcePath: z.string().min(1),
});

const verifyInputSchema = z.object({
  action: z.literal('verify'),
  workItem: workItemSchema,
  worktreePath: z.string().min(1),
  repos: z.array(repoNameSchema).min(1).max(10).optional(),
});

const closeInputSchema = z.object({
  action: z.literal('close'),
  workItem: workItemSchema,
  partial: z.boolean().optional(),
  approvedByUser: z.boolean().optional(),
  repos: z.array(repoNameSchema).min(1).max(10).optional(),
});

const getInputSchema = z.object({
  action: z.literal('get'),
  workItem: workItemSchema,
});

type AnyActionInput =
  | z.infer<typeof openInputSchema>
  | z.infer<typeof updateInputSchema>
  | z.infer<typeof scopeChangeInputSchema>
  | z.infer<typeof evidenceInputSchema>
  | z.infer<typeof verifyInputSchema>
  | z.infer<typeof closeInputSchema>
  | z.infer<typeof getInputSchema>;

// ─── Registration ───────────────────────────────────────────────────────────

export function registerTask(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Task document',
      description: DESCRIPTION,
      // The one REGISTERED schema — .strict(), flat, every field optional
      // except action/workItem (see tools/task-metrics.ts for the same pattern).
      inputSchema: z
        .object({
          action: z.enum(['open', 'update', 'scope_change', 'evidence', 'verify', 'close', 'get']),
          workItem: workItemSchema,
          route: routeSchema.optional(),
          title: z.string().max(120).optional(),
          request: z.string().max(4000).optional(),
          criteria: z.array(z.string().max(300)).min(1).max(20).optional(),
          worktreePath: z.string().optional(),
          repos: z.array(repoNameSchema).min(1).max(10).optional(),
          progress: z.string().max(500).optional(),
          nextStep: z.string().max(300).optional(),
          checklist: z.array(checklistItemSchema).max(30).optional(),
          acUpdates: z.array(acUpdateSchema).optional(),
          change: z.enum(['add', 'reopen', 'discard']).optional(),
          acId: acIdSchema.optional(),
          text: z.string().max(300).optional(),
          reason: z.string().max(300).optional(),
          requestedByUser: z.boolean().optional(),
          kind: z.enum(['qa', 'manual']).optional(),
          sourcePath: z.string().optional(),
          partial: z.boolean().optional(),
          approvedByUser: z.boolean().optional(),
        })
        .strict(),
    },
    async (rawInput) => {
      let parsed: AnyActionInput;
      try {
        const action = (rawInput as { action?: string }).action;
        switch (action) {
          case 'open':
            parsed = openInputSchema.parse(rawInput);
            break;
          case 'update':
            parsed = updateInputSchema.parse(rawInput);
            break;
          case 'scope_change':
            parsed = scopeChangeInputSchema.parse(rawInput);
            break;
          case 'evidence':
            parsed = evidenceInputSchema.parse(rawInput);
            break;
          case 'verify':
            parsed = verifyInputSchema.parse(rawInput);
            break;
          case 'close':
            parsed = closeInputSchema.parse(rawInput);
            break;
          case 'get':
            parsed = getInputSchema.parse(rawInput);
            break;
          default:
            return errResult(
              'Acción inválida. Usa: open, update, scope_change, evidence, verify, close o get.',
            );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return errResult(`Error de validación: ${msg}`);
      }

      const vaultRes = await resolveTaskVault(services);

      // verify/get/close never need a FS lock on a vault that doesn't exist
      // (verify runs regardless of a vault, O6); open/update/scope_change/
      // evidence all need the lock to serialize reads+writes of the doc.
      const mutex = getTaskMutex(services);
      const key = vaultRes.vaultPath
        ? taskLockKey(vaultRes.vaultPath, parsed.workItem)
        : `task|novault|${normalizeWorkItemId(parsed.workItem)}`;

      const { result } = await withVaultLock(mutex, key, { onBusy: 'wait', logger }, async () => {
        switch (parsed.action) {
          case 'open':
            return handleOpen(parsed, services, logger, vaultRes);
          case 'update':
            return handleUpdate(parsed, services, logger, vaultRes);
          case 'scope_change':
            return handleScopeChange(parsed, services, logger, vaultRes);
          case 'evidence':
            return handleEvidence(parsed, services, logger, vaultRes);
          case 'verify':
            return handleVerify(parsed, services, logger, vaultRes);
          case 'close':
            return handleClose(parsed, services, logger, vaultRes);
          case 'get':
            return handleGet(parsed, services, logger, vaultRes);
        }
      });

      // D-9/B6: `taskMutex` is released by now (the callback above already
      // returned). `close`'s own `taskEvidence` write happens HERE, under
      // `metricsMutex` — never nested inside `taskMutex` — exactly like
      // `recordToolSpan` (metrics-span.ts).
      if (isClosedOutcome(result)) {
        return await finalizeClose(result, services, logger);
      }

      return result ?? errResult('Error inesperado en chamba_task.');
    },
  );
}

// ─── Helpers shared across handlers ─────────────────────────────────────────

interface VaultRes {
  vaultPath?: string;
  reason?: string;
}

function okResult(text: string, structured?: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

function errResult(text: string) {
  return { isError: true as const, content: [{ type: 'text' as const, text }] };
}

function criterionLine(ac: AcceptanceCriterion): string {
  const parts = [`${ac.id} · ${ac.estado} — ${ac.text}`];
  if (ac.reason) parts.push(`razón: ${ac.reason}`);
  return parts.join(' · ');
}

async function readReposLayer(services: Services, path: string): Promise<ReposConfig | undefined> {
  try {
    if (!(await services.fs.exists(path))) return undefined;
    const text = await services.fs.readFile(path);
    const parsed = parseChambaConfig(JSON.parse(text));
    return parsed.ok ? parsed.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * B4: every evidence path the close gate (pure, no IO) is allowed to treat
 * as "real" — `doc.evidence[].path` + every `VerifyRun.commands[].evidencePath`
 * PLUS (the same fallback `update` itself accepts) any AC evidence ref that
 * isn't tracked there but DOES exist as a file under the task's own
 * `tareas/<id>/evidencia/` folder on disk. The IO happens here (the impure
 * mcp layer); `evaluateCloseGate` itself only ever compares against the
 * resulting array.
 */
async function resolveKnownEvidencePaths(
  services: Services,
  vaultPath: string,
  doc: TaskDoc,
): Promise<string[]> {
  const known = new Set<string>([
    ...doc.evidence.map((e) => e.path),
    ...doc.verifyRuns.flatMap((r) =>
      r.commands.map((c) => c.evidencePath).filter((p): p is string => Boolean(p)),
    ),
  ]);
  const evidencePrefix = `tareas/${normalizeWorkItemId(doc.workItem)}/evidencia/`;
  for (const ac of doc.criteria) {
    for (const ref of ac.evidence) {
      if (known.has(ref) || !ref.startsWith(evidencePrefix)) continue;
      try {
        if (await services.fs.exists(joinPath(vaultPath, ref))) known.add(ref);
      } catch {
        // leave unresolved
      }
    }
  }
  return [...known];
}

/**
 * B2: derive the repo(s) this task touched, in order of confidence:
 * explicit `repos` on the call > `repos` persisted at `open` > the
 * worktree's own basename matched against the workspace's real repo map.
 *
 * `detectGitRepos(fs, X)` looks at CHILDREN of `X` — it must be called on
 * `wsRoot`, never on `doc.worktreePath` (the worktree dir itself IS a repo
 * in the `<WORKTREES>/<ticket>/<repo>` layout, not a container of repos).
 */
async function deriveReposTouched(
  services: Services,
  doc: TaskDoc,
  explicitRepos: string[] | undefined,
  wsRoot: string,
): Promise<string[]> {
  const given = explicitRepos ?? doc.repos ?? [];
  if (given.length > 0) return given;
  if (!doc.worktreePath) return [];
  try {
    const style = detectStyle(services.platform);
    const basename = localBasename(doc.worktreePath, style);
    const known = await detectGitRepos(services.fs, wsRoot);
    const match = known.find((r) => caseFoldLocal(r, style) === caseFoldLocal(basename, style));
    return match ? [match] : [];
  } catch {
    return [];
  }
}

// ─── open ───────────────────────────────────────────────────────────────────

async function handleOpen(
  input: z.infer<typeof openInputSchema>,
  services: Services,
  logger: Logger,
  vaultRes: VaultRes,
) {
  if (input.route === 'trivial') {
    return okResult(
      `Ruta trivial para ${input.workItem}: no se crea documento. Usá chamba_task action='verify' si hay comandos configurados y pegá el resultado en chamba_summarize_to_vault.`,
      { document: null, route: 'trivial' },
    );
  }

  if (!vaultRes.vaultPath) {
    return okResult(
      `${vaultRes.reason ?? 'sin vault configurado'} — ${input.workItem} continúa sin documento (como ruta trivial); verify/close siguen evaluando lo que tengan.`,
      { document: null, degraded: true },
    );
  }
  const vaultPath = vaultRes.vaultPath;

  const pathCheck = validateTaskNotePath(input.workItem);
  if (!pathCheck.ok) return errResult(pathCheck.error);

  const existing = await readTaskDoc(services, vaultPath, input.workItem);
  if ('error' in existing) return errResult(existing.error);
  if (existing.found) {
    return okResult(`${input.workItem} ya existía — no se reescribe.`, {
      document: summarizeDoc(existing.doc),
      alreadyExisted: true,
    });
  }

  const title = input.title ?? input.workItem;
  const request = (input.request ?? '').slice(0, 4000);
  const criteriaTexts = input.criteria ?? [];
  if (criteriaTexts.length === 0) {
    return errResult("'open' en una ruta no trivial requiere al menos un criterio en 'criteria'.");
  }

  const gate = await secretWriteGate(services.hash, [
    { field: 'title', value: title },
    { field: 'request', value: request },
    { field: 'criteria', value: criteriaTexts },
  ]);
  if (gate.blocked) return errResult(gate.text as string);

  const criteria: AcceptanceCriterion[] = assignAcIds(criteriaTexts).map((ac) => ({
    ...ac,
    estado: 'pendiente' as const,
    evidence: [],
  }));

  const date = services.clock.today();
  const doc: TaskDoc = {
    workItem: input.workItem,
    title,
    route: input.route,
    request,
    criteria,
    checklist: [],
    progressLog: [`- ${date}: tarea abierta.`],
    nextStep: '',
    scopeChanges: [],
    verifyRuns: [],
    evidence: [],
    estadoTarea: 'abierta',
    ...(input.worktreePath ? { worktreePath: input.worktreePath } : {}),
    ...(input.repos && input.repos.length > 0 ? { repos: input.repos } : {}),
  };
  doc.nextStep = computeNextStep(doc);

  const author = await resolveTaskAuthor(services);
  await writeTaskDoc(services, vaultPath, doc, {
    date,
    author,
    agentVersion: services.version,
    writtenAt: services.clock.now().toISOString(),
  });
  await reindexTaskVault(services, vaultPath, logger);

  logger.info({ tool: TOOL_NAME, action: 'open', workItem: input.workItem }, 'task opened');

  return okResult(
    `${input.workItem} abierto (ruta ${input.route}). Criterios: ${criteria.map((c) => c.id).join(', ')}.`,
    { document: summarizeDoc(doc) },
  );
}

// ─── update ─────────────────────────────────────────────────────────────────

async function handleUpdate(
  input: z.infer<typeof updateInputSchema>,
  services: Services,
  _logger: Logger,
  vaultRes: VaultRes,
) {
  if (!vaultRes.vaultPath) {
    return okResult(
      `${vaultRes.reason ?? 'sin vault configurado'} — no hay documento para actualizar.`,
      {
        degraded: true,
      },
    );
  }
  const vaultPath = vaultRes.vaultPath;

  const existing = await readTaskDoc(services, vaultPath, input.workItem);
  if ('error' in existing) return errResult(existing.error);
  if (!existing.found) {
    return errResult(
      `no existe un documento de tarea para ${input.workItem}; llamá a 'open' primero.`,
    );
  }
  const doc = existing.doc;

  const gate = await secretWriteGate(services.hash, [
    { field: 'progress', value: input.progress },
    { field: 'nextStep', value: input.nextStep },
    { field: 'checklist', value: (input.checklist ?? []).map((c) => c.text) },
    { field: 'acUpdates.reason', value: (input.acUpdates ?? []).map((u) => u.reason ?? '') },
  ]);
  if (gate.blocked) return errResult(gate.text as string);

  const date = services.clock.today();
  let criteria = doc.criteria;
  const unknownAc: string[] = [];
  for (const upd of input.acUpdates ?? []) {
    const ac = criteria.find((a) => a.id === upd.id);
    if (!ac) {
      unknownAc.push(upd.id);
      continue;
    }
    criteria = criteria.map((a) =>
      a.id === upd.id
        ? {
            ...a,
            estado: upd.estado as AcceptanceCriterion['estado'],
            ...(upd.evidence !== undefined ? { evidence: upd.evidence } : {}),
            ...(upd.reason !== undefined ? { reason: upd.reason } : {}),
          }
        : a,
    );
  }
  if (unknownAc.length > 0) {
    return errResult(`no existe(n) en este documento: ${unknownAc.join(', ')}.`);
  }

  // B4: `estado:'pasa'` is only as good as the evidence it points to.
  // Resolve each ref against what the document itself already tracks
  // (`doc.evidence[].path` + every VerifyRun command's `evidencePath`) or,
  // failing that, an existing file under the task's own evidence folder —
  // reject with the literal list of refs that resolve to nothing.
  const pasaUpdatesWithEvidence = (input.acUpdates ?? []).filter(
    (u) => u.estado === 'pasa' && u.evidence !== undefined,
  );
  if (pasaUpdatesWithEvidence.length > 0) {
    const known = new Set<string>([
      ...doc.evidence.map((e) => e.path),
      ...doc.verifyRuns.flatMap((r) =>
        r.commands.map((c) => c.evidencePath).filter((p): p is string => Boolean(p)),
      ),
    ]);
    const evidencePrefix = `tareas/${normalizeWorkItemId(input.workItem)}/evidencia/`;
    const unresolved: string[] = [];
    for (const upd of pasaUpdatesWithEvidence) {
      for (const ref of upd.evidence ?? []) {
        if (known.has(ref)) continue;
        if (ref.startsWith(evidencePrefix)) {
          try {
            if (await services.fs.exists(joinPath(vaultPath, ref))) continue;
          } catch {
            // falls through to unresolved
          }
        }
        unresolved.push(ref);
      }
    }
    if (unresolved.length > 0) {
      return errResult(
        `las siguientes referencias de evidencia no resuelven a nada registrado por verify/evidence en el documento ni a un archivo existente: ${unresolved.join(', ')}.`,
      );
    }
  }

  const progressLog =
    input.progress !== undefined
      ? [...doc.progressLog, `- ${date}: ${input.progress}`]
      : doc.progressLog;
  const checklist: ChecklistItem[] = input.checklist ?? doc.checklist;

  let updated: TaskDoc = { ...doc, criteria, progressLog, checklist };
  updated = { ...updated, nextStep: input.nextStep ?? computeNextStep(updated) };

  const author = await resolveTaskAuthor(services);
  await writeTaskDoc(services, vaultPath, updated, {
    date,
    author,
    agentVersion: services.version,
    writtenAt: services.clock.now().toISOString(),
  });

  return okResult(`${input.workItem} actualizado. Siguiente paso: ${updated.nextStep}`, {
    document: summarizeDoc(updated),
  });
}

// ─── scope_change ───────────────────────────────────────────────────────────

async function handleScopeChange(
  input: z.infer<typeof scopeChangeInputSchema>,
  services: Services,
  _logger: Logger,
  vaultRes: VaultRes,
) {
  if (!vaultRes.vaultPath) {
    return errResult(
      `${vaultRes.reason ?? 'sin vault configurado'} — no hay documento para cambiar de alcance.`,
    );
  }
  const vaultPath = vaultRes.vaultPath;

  const existing = await readTaskDoc(services, vaultPath, input.workItem);
  if ('error' in existing) return errResult(existing.error);
  if (!existing.found) {
    return errResult(
      `no existe un documento de tarea para ${input.workItem}; llamá a 'open' primero.`,
    );
  }
  const doc = existing.doc;

  const gate = await secretWriteGate(services.hash, [
    { field: 'text', value: input.text },
    { field: 'reason', value: input.reason },
  ]);
  if (gate.blocked) return errResult(gate.text as string);

  const date = services.clock.today();
  const applied = applyScopeChange(doc, {
    change: input.change,
    date,
    text: input.text,
    acId: input.acId,
    reason: input.reason,
    requestedByUser: input.requestedByUser,
  });
  if (!applied.ok) return errResult(applied.error);

  const author = await resolveTaskAuthor(services);
  await writeTaskDoc(services, vaultPath, applied.doc, {
    date,
    author,
    agentVersion: services.version,
    writtenAt: services.clock.now().toISOString(),
  });

  return okResult(`${input.workItem}: cambio de alcance '${input.change}' aplicado.`, {
    document: summarizeDoc(applied.doc),
  });
}

// ─── evidence ───────────────────────────────────────────────────────────────

async function handleEvidence(
  input: z.infer<typeof evidenceInputSchema>,
  services: Services,
  _logger: Logger,
  vaultRes: VaultRes,
) {
  if (!vaultRes.vaultPath) {
    return errResult(
      `${vaultRes.reason ?? 'sin vault configurado'} — no se puede adjuntar evidencia.`,
    );
  }
  const vaultPath = vaultRes.vaultPath;

  const existing = await readTaskDoc(services, vaultPath, input.workItem);
  if ('error' in existing) return errResult(existing.error);
  if (!existing.found) {
    return errResult(
      `no existe un documento de tarea para ${input.workItem}; llamá a 'open' primero.`,
    );
  }
  const doc = existing.doc;
  const date = services.clock.today();

  if (input.kind === 'manual') {
    if (!input.sourcePath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(input.sourcePath)) {
      return errResult(`sourcePath debe ser una ruta absoluta: "${input.sourcePath}".`);
    }
    // B4: `kind='manual'` is agent-asserted — require the path to actually
    // exist, and to be contained under the SAME roots `evidence kind='qa'`
    // trusts (the two `.chamba/qa-evidence` roots) or under the task's own
    // worktree. Anything else is restricted: chamba never records a manual
    // evidence pointer to an arbitrary disk path it can't vouch for at all.
    if (!(await services.fs.exists(input.sourcePath))) {
      return errResult(`sourcePath no existe: "${input.sourcePath}".`);
    }
    const wsRootForEvidence = await resolveWsRoot(services);
    const allowedManualRoots = [
      joinPath(wsRootForEvidence, '.chamba', 'qa-evidence'),
      joinPath(services.homedir, '.chamba', 'qa-evidence'),
      ...(doc.worktreePath ? [doc.worktreePath] : []),
    ];
    const style = detectStyle(services.platform);
    let realSource: string;
    try {
      realSource = await services.fs.realpath(input.sourcePath);
    } catch {
      return errResult(`no se pudo resolver sourcePath: "${input.sourcePath}".`);
    }
    const contained = allowedManualRoots.some((root) => isUnderLocal(root, realSource, style));
    if (!contained) {
      return errResult(
        `sourcePath "${input.sourcePath}" debe estar bajo el worktree de la tarea o las carpetas de evidencia QA (.chamba/qa-evidence); chamba no registra evidencia manual de rutas arbitrarias.`,
      );
    }
    const updated: TaskDoc = {
      ...doc,
      evidence: [...doc.evidence, { path: input.sourcePath, kind: 'manual' }],
    };
    const author = await resolveTaskAuthor(services);
    await writeTaskDoc(services, vaultPath, updated, {
      date,
      author,
      agentVersion: services.version,
      writtenAt: services.clock.now().toISOString(),
    });
    return okResult(`${input.workItem}: evidencia manual registrada (${input.sourcePath}).`, {
      document: summarizeDoc(updated),
    });
  }

  const runId = await generateRunId(services, vaultPath, input.workItem, date);
  const copyRes = await copyQaEvidence({
    services,
    sourcePath: input.sourcePath,
    vaultPath,
    workItem: input.workItem,
    runId,
  });
  if (!copyRes.ok) return errResult(copyRes.error);

  const updated: TaskDoc = {
    ...doc,
    evidence: [...doc.evidence, ...copyRes.copied, ...copyRes.linkedOnly],
  };
  const author = await resolveTaskAuthor(services);
  await writeTaskDoc(services, vaultPath, updated, {
    date,
    author,
    agentVersion: services.version,
    writtenAt: services.clock.now().toISOString(),
  });

  const lines = [
    `${input.workItem}: ${copyRes.copied.length} archivo(s) copiado(s), ${copyRes.linkedOnly.length} enlazado(s) sin copiar.`,
    ...copyRes.notes.map((n) => `  ${n}`),
  ];
  return okResult(lines.join('\n'), { document: summarizeDoc(updated) });
}

// ─── verify ─────────────────────────────────────────────────────────────────

async function handleVerify(
  input: z.infer<typeof verifyInputSchema>,
  services: Services,
  logger: Logger,
  vaultRes: VaultRes,
) {
  const date = services.clock.today();

  // Read the document BEFORE running anything (B1): a document bound to a
  // worktree is the gate `verify` must respect — never run first and decide
  // afterwards whether it "counts".
  let doc: TaskDoc | undefined;
  if (vaultRes.vaultPath) {
    const existing = await readTaskDoc(services, vaultRes.vaultPath, input.workItem);
    if ('error' in existing) return errResult(existing.error);
    if (existing.found) doc = existing.doc;
  }

  // B1: verify MUST target the same worktree the document is bound to. If
  // the document has no worktreePath yet, this call binds it (first verify
  // wins) — see the write below. Comparison uses realpath + the B5 win32-
  // safe case-fold helper, never a raw string `===`.
  if (doc?.worktreePath) {
    const style = detectStyle(services.platform);
    let realInput: string;
    try {
      realInput = await services.fs.realpath(input.worktreePath);
    } catch {
      return errResult(`worktreePath no existe o no se pudo resolver: "${input.worktreePath}".`);
    }
    let realDoc: string;
    try {
      realDoc = await services.fs.realpath(doc.worktreePath);
    } catch {
      realDoc = doc.worktreePath;
    }
    if (caseFoldLocal(realInput, style) !== caseFoldLocal(realDoc, style)) {
      return errResult(
        `verify debe correr sobre el worktree de ${input.workItem} ("${doc.worktreePath}"), no "${input.worktreePath}". ` +
          'Si el worktree cambió legítimamente, abrí la tarea de nuevo (open) desde el worktree correcto.',
      );
    }
  }

  const result = await runVerify({
    services,
    worktreePath: input.worktreePath,
    repos: input.repos,
    date,
  });
  if (!result.ok) return errResult(result.error);

  const run = result.run;

  if (!vaultRes.vaultPath || !doc) {
    // No vault, or no document (trivial route, or not opened yet) — nothing
    // to bind/gate against; same degraded behavior as before.
    return okResult(result.summaryBlock, { blockMarkdown: result.summaryBlock, document: null });
  }
  const vaultPath = vaultRes.vaultPath;

  const runId = await generateRunId(services, vaultPath, input.workItem, date);
  const finalRun: VerifyRun = { ...run, runId, worktreePath: input.worktreePath };

  const commandsWithEvidence: VerifyRunCommandResult[] = [];
  for (const [i, outcome] of result.outcomes.entries()) {
    const evidenceMd = renderOutcomeEvidence(outcome, finalRun);
    const relDir = `tareas/${normalizeWorkItemId(input.workItem)}/evidencia/${runId}`;
    const relPath = `${relDir}/tests-${outcome.name}.md`;
    const absPath = joinPath(vaultPath, relPath);
    await services.fs.mkdir(absPath.slice(0, absPath.lastIndexOf('/')));
    await services.fs.writeBytes(absPath, new TextEncoder().encode(evidenceMd));
    commandsWithEvidence.push({
      ...(finalRun.commands[i] as VerifyRunCommandResult),
      evidencePath: relPath,
    });
  }
  finalRun.commands = commandsWithEvidence.length > 0 ? commandsWithEvidence : finalRun.commands;

  const updated: TaskDoc = {
    ...doc,
    verifyRuns: [...doc.verifyRuns, finalRun],
    // B1: first verify binds the document to this worktree.
    ...(doc.worktreePath ? {} : { worktreePath: input.worktreePath }),
  };
  const author = await resolveTaskAuthor(services);
  await writeTaskDoc(services, vaultPath, updated, {
    date,
    author,
    agentVersion: services.version,
    writtenAt: services.clock.now().toISOString(),
  });

  logger.info(
    { tool: TOOL_NAME, action: 'verify', workItem: input.workItem, runId, level: finalRun.level },
    'verify run recorded',
  );

  return okResult(result.summaryBlock, {
    blockMarkdown: result.summaryBlock,
    document: summarizeDoc(updated),
    run: finalRun,
  });
}

// ─── close ──────────────────────────────────────────────────────────────────

/**
 * Discriminated result of a SUCCESSFUL `close` (gate passed, document
 * written). `handleClose` returns this instead of a tool result so the
 * caller (`registerTask`) can write the `taskEvidence` AFTER releasing
 * `taskMutex` (B6) — an early exit (vault missing / doc missing / gate
 * rejected) still returns a plain tool result directly.
 */
interface ClosedOutcome {
  kind: 'closed';
  workItem: string;
  wsRoot: string;
  runId?: string;
  verifyLevel?: VerifyRun['level'];
  testsPassed: boolean;
  delivered: boolean;
  partial: boolean;
  document: Record<string, unknown>;
  closeBlockMarkdown: string;
}

function isClosedOutcome(value: unknown): value is ClosedOutcome {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value as { kind?: unknown }).kind === 'closed'
  );
}

async function handleClose(
  input: z.infer<typeof closeInputSchema>,
  services: Services,
  logger: Logger,
  vaultRes: VaultRes,
): Promise<ReturnType<typeof okResult> | ReturnType<typeof errResult> | ClosedOutcome> {
  if (!vaultRes.vaultPath) {
    return errResult(
      `${vaultRes.reason ?? 'sin vault configurado'} — no se puede cerrar ${input.workItem}.`,
    );
  }
  const vaultPath = vaultRes.vaultPath;

  const existing = await readTaskDoc(services, vaultPath, input.workItem);
  if ('error' in existing) return errResult(existing.error);
  if (!existing.found) {
    return errResult(
      `no existe un documento de tarea para ${input.workItem}; llamá a 'open' primero.`,
    );
  }
  const doc = existing.doc;
  const date = services.clock.today();
  const wsRoot = await resolveWsRoot(services);

  const reposTouched = await deriveReposTouched(services, doc, input.repos, wsRoot);

  const globalLayer = await readReposLayer(services, joinPath(services.homedir, CONFIG_FILE));
  const projectLayer = await readReposLayer(services, joinPath(wsRoot, CONFIG_FILE));
  const layers = [globalLayer, projectLayer];

  // B4: every evidence path chamba itself has recorded for this document —
  // close-gate (pure) validates AC-evidence refs resolve against this set.
  const knownEvidencePaths = await resolveKnownEvidencePaths(services, vaultPath, doc);

  const lastRun = doc.verifyRuns[doc.verifyRuns.length - 1];
  const gateInput: CloseGateInput = {
    route: doc.route,
    criteria: doc.criteria,
    scopeChanges: doc.scopeChanges,
    lastVerifyRun: lastRun,
    reposWithVerifyConfigured: reposWithVerifyConfigured(layers),
    reposTouched,
    knownEvidencePaths,
    documentWorktreePath: doc.worktreePath,
    partial: input.partial,
    approvedByUser: input.approvedByUser,
  };
  const gate = evaluateCloseGate(gateInput);

  if (!gate.ok) {
    return errResult(
      `no se puede cerrar ${input.workItem} — no lo rodees: resolvé lo que falta o pedí cierre parcial con aprobación del usuario.\n` +
        gate.missing.map((m) => `- ${m}`).join('\n'),
    );
  }

  const closeBlockMarkdown = renderCloseBlock(doc, gate.partial, gate.pending, lastRun, date);

  let updated: TaskDoc = {
    ...doc,
    estadoTarea: 'cerrada',
    closeBlock: closeBlockMarkdown,
  };

  if (gate.partial) {
    const entry: ScopeChangeEntry = {
      date,
      change: 'reopen',
      acId: 'AC-0',
      reason: `cierre parcial aprobado por el usuario — pendiente: ${gate.pending.join('; ') || '(ninguno adicional)'}`,
      requestedByUser: true,
    };
    updated = {
      ...updated,
      progressLog: [
        ...updated.progressLog,
        `- ${date}: cierre parcial aprobado por el usuario. Pendiente: ${gate.pending.join('; ') || '(ninguno)'}`,
      ],
      scopeChanges: [...updated.scopeChanges, entry],
    };
  }

  const author = await resolveTaskAuthor(services);
  await writeTaskDoc(services, vaultPath, updated, {
    date,
    author,
    agentVersion: services.version,
    writtenAt: services.clock.now().toISOString(),
  });
  await reindexTaskVault(services, vaultPath, logger);

  // B3: vacuously-true on an empty array is the exact bug — `testsPassed`
  // is true ONLY when chamba itself measured it (`level === 'executed'`)
  // with at least one command, all green. A `reported-by-agent` run (no
  // command configured) or a run with zero commands is NOT "tests passed".
  const testsPassed = Boolean(
    lastRun &&
      lastRun.level === 'executed' &&
      lastRun.commands.length > 0 &&
      lastRun.commands.every((c) => c.exitCode === 0 && !c.timedOut),
  );
  const delivered = !gate.partial;

  logger.info(
    {
      tool: TOOL_NAME,
      action: 'close',
      workItem: input.workItem,
      delivered,
      partial: gate.partial,
    },
    'task closed',
  );

  return {
    kind: 'closed',
    workItem: input.workItem,
    wsRoot,
    runId: lastRun?.runId,
    verifyLevel: lastRun?.level,
    testsPassed,
    delivered,
    partial: gate.partial,
    document: summarizeDoc(updated),
    closeBlockMarkdown,
  };
}

/**
 * B6/D-9: writes `taskEvidence` to the inflight metric AFTER `taskMutex` has
 * been released by the caller — under `metricsMutex`, never nested — using
 * the SAME normalized-id matching as `recordToolSpan` (metrics-span.ts,
 * N11) instead of a raw path lookup (filesystem case-sensitivity differs by
 * platform).
 */
async function finalizeClose(
  outcome: ClosedOutcome,
  services: Services,
  logger: Logger,
): Promise<ReturnType<typeof okResult>> {
  const { wsRoot, workItem } = outcome;
  let note = '';

  const mutex = getMutex(services);
  await withVaultLock(mutex, lockKey(wsRoot), { onBusy: 'wait', logger }, async () => {
    const normalizedTarget = normalizeWorkItemId(workItem);
    const ids = await listInflightIds(services, wsRoot);
    const matches = ids.filter((id) => normalizeWorkItemId(id) === normalizedTarget);
    if (matches.length !== 1) {
      note = `no hay métricas activas para ${workItem}: el cierre quedó escrito, pero testsPassed/delivered no se registraron.`;
      return;
    }
    const matchedId = matches[0] as string;
    const inflight = await readInflight(services, wsRoot, matchedId);
    if (!inflight) {
      note = `no hay métricas activas para ${workItem}: el cierre quedó escrito, pero testsPassed/delivered no se registraron.`;
      return;
    }
    inflight.taskEvidence = {
      testsPassed: outcome.testsPassed,
      delivered: outcome.delivered,
      partial: outcome.partial,
      runId: outcome.runId,
      verifyLevel: outcome.verifyLevel,
    };
    await writeInflight(services, wsRoot, inflight);
    note = 'métricas actualizadas (taskEvidence).';
  });

  return okResult(`${outcome.workItem} cerrado. ${note}`, {
    document: outcome.document,
    closeBlockMarkdown: outcome.closeBlockMarkdown,
    testsPassed: outcome.testsPassed,
    delivered: outcome.delivered,
    partial: outcome.partial,
  });
}

function renderCloseBlock(
  doc: TaskDoc,
  partial: boolean,
  pending: string[],
  lastRun: VerifyRun | undefined,
  date: string,
): string {
  const implemented = doc.criteria.filter((c) => c.estado === 'pasa' || c.estado === 'descartado');
  const verified = doc.criteria.filter((c) => c.estado === 'pasa');
  const stillPending = doc.criteria.filter((c) => c.estado === 'pendiente' || c.estado === 'falla');

  const lines: string[] = [];
  lines.push('### Implementado');
  lines.push(
    implemented.length > 0
      ? implemented.map((c) => `- ${criterionLine(c)}`).join('\n')
      : '- (ninguno)',
  );
  lines.push('');
  lines.push('### Verificado (con evidencia)');
  if (lastRun) {
    lines.push(
      `- verify sobre \`${lastRun.head ?? '(sin head)'}\` (${lastRun.dirty ? 'sucio' : 'limpio'}), nivel: ${lastRun.level}`,
    );
  }
  lines.push(
    verified.length > 0 ? verified.map((c) => `- ${criterionLine(c)}`).join('\n') : '- (ninguno)',
  );
  lines.push('');
  lines.push('### Pendiente');
  lines.push(
    stillPending.length > 0
      ? stillPending.map((c) => `- ${criterionLine(c)}`).join('\n')
      : '- (ninguno)',
  );
  if (partial) {
    lines.push('');
    lines.push(
      `**cierre parcial aprobado por el usuario** (${date}). Pendiente: ${pending.join('; ') || '(ninguno adicional)'}.`,
    );
  }
  return lines.join('\n');
}

// ─── get ────────────────────────────────────────────────────────────────────

async function handleGet(
  input: z.infer<typeof getInputSchema>,
  services: Services,
  _logger: Logger,
  vaultRes: VaultRes,
) {
  if (!vaultRes.vaultPath) {
    return okResult(
      `${vaultRes.reason ?? 'sin vault configurado'} — no hay documento para ${input.workItem}.`,
      {
        document: null,
      },
    );
  }
  const vaultPath = vaultRes.vaultPath;

  // N1: `get` only reads — it reports a hand-edit of a controlled block
  // instead of hard-blocking (that's what update/scope_change/verify/close do).
  const existing = await readTaskDoc(services, vaultPath, input.workItem, {
    enforceIntegrity: false,
  });
  if ('error' in existing) return errResult(existing.error);
  if (!existing.found) {
    return okResult(`no existe un documento de tarea para ${input.workItem}.`, { document: null });
  }
  const doc = existing.doc;

  const wsRoot = await resolveWsRoot(services);
  const globalLayer = await readReposLayer(services, joinPath(services.homedir, CONFIG_FILE));
  const projectLayer = await readReposLayer(services, joinPath(wsRoot, CONFIG_FILE));
  const layers = [globalLayer, projectLayer];
  const lastRun = doc.verifyRuns[doc.verifyRuns.length - 1];
  const reposTouched = await deriveReposTouched(services, doc, undefined, wsRoot);
  const knownEvidencePaths = await resolveKnownEvidencePaths(services, vaultPath, doc);

  const gate = evaluateCloseGate({
    route: doc.route,
    criteria: doc.criteria,
    scopeChanges: doc.scopeChanges,
    lastVerifyRun: lastRun,
    reposWithVerifyConfigured: reposWithVerifyConfigured(layers),
    reposTouched,
    knownEvidencePaths,
    documentWorktreePath: doc.worktreePath,
  });

  const siguientePaso = computeNextStep(doc);
  const nonce = services.random.hex(12);
  const wrapped = wrapVaultData(
    JSON.stringify(summarizeDoc(doc)),
    { ruta: `tareas/${normalizeWorkItemId(input.workItem)}.md` },
    nonce,
  );

  const integrityNote =
    'integrityViolation' in existing && existing.integrityViolation
      ? '\n\nATENCIÓN (N1): el documento fue editado a mano en un bloque que gestiona chamba ' +
        '(criterios de aceptación, evidencia/verify o cambios de alcance) — update/scope_change/' +
        'verify/close lo van a rechazar hasta que se resuelva.'
      : '';

  return okResult(wrapped + integrityNote, {
    document: summarizeDoc(doc),
    siguientePaso,
    compuerta: gate,
    lastVerifyRun: lastRun,
    worktreePath: doc.worktreePath,
    ...('integrityViolation' in existing
      ? { integrityViolation: existing.integrityViolation }
      : {}),
  });
}

// ─── summarize ──────────────────────────────────────────────────────────────

function summarizeDoc(doc: TaskDoc): Record<string, unknown> {
  return {
    workItem: doc.workItem,
    title: doc.title,
    route: doc.route,
    estadoTarea: doc.estadoTarea,
    criteria: doc.criteria,
    checklist: doc.checklist,
    nextStep: doc.nextStep,
    scopeChanges: doc.scopeChanges,
    verifyRuns: doc.verifyRuns,
    evidence: doc.evidence,
    worktreePath: doc.worktreePath,
    closeBlock: doc.closeBlock,
  };
}
