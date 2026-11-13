/**
 * tasks/task-doc.ts — CHAMBA-022
 *
 * The in-memory model of a task document (`tareas/<id>.md`) plus its
 * markdown render/parse. Pure TypeScript: no `node:` imports, no IO, no
 * `ClockPort` (callers pass in whatever `date`/`nowIso` the port gave them).
 *
 * Route `trivial` never gets a document — callers must check before calling
 * `renderTaskDoc`.
 */

import { normalizeWorkItemId } from '../metrics/task-phases.js';
import type { Route } from '../routing/classify.js';
import { joinPath } from '../util/path.js';
import { readBlock, type TaskBlockName, upsertBlock } from './task-blocks.js';

/** Routes that get a live task document (`trivial` never does). */
export type TaskRouteProfile = Exclude<Route, 'trivial'>;

export type AcEstado = 'pendiente' | 'pasa' | 'falla' | 'descartado';

export interface AcceptanceCriterion {
  id: string;
  /** Immutable once written — see criteria.ts. */
  text: string;
  estado: AcEstado;
  /** Vault-relative paths to evidence (tests-*.md, qa reports, captures). */
  evidence: string[];
  reason?: string;
}

export interface ChecklistItem {
  text: string;
  done: boolean;
}

export interface ScopeChangeEntry {
  /** ISO date (YYYY-MM-DD) of the change. */
  date: string;
  change: 'add' | 'reopen' | 'discard';
  acId: string;
  reason: string;
  requestedByUser: boolean;
}

export interface VerifyRunCommandResult {
  name: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  /** Vault-relative path to the per-command evidence file, if written. */
  evidencePath?: string;
}

export interface VerifyRun {
  runId: string;
  /** ISO date (YYYY-MM-DD) of the run. */
  date: string;
  head?: string;
  dirty?: boolean;
  commands: VerifyRunCommandResult[];
  /** `executed`: chamba ran it via `ProcessPort.run`. `reported-by-agent`: no command configured. */
  level: 'executed' | 'reported-by-agent';
  /**
   * The worktree this run executed against (B1). Recorded so a document's
   * close gate can detect a run that doesn't correspond to `TaskDoc.worktreePath`
   * — `chamba_task verify` itself is the primary gate (task.ts), this is
   * defense-in-depth for a document edited or carried over oddly.
   */
  worktreePath?: string;
}

export interface EvidenceRef {
  /** Vault-relative path. */
  path: string;
  kind: 'qa' | 'manual' | 'verify';
  /** True when the file was too large/numerous to copy and is only linked. */
  linkOnly?: boolean;
}

export type TaskEstado = 'abierta' | 'en_progreso' | 'verificada' | 'cerrada' | 'bloqueada';

export interface TaskDoc {
  workItem: string;
  title: string;
  route: TaskRouteProfile;
  /** Verbatim request (redacted), ≤ 4000 chars. */
  request: string;
  criteria: AcceptanceCriterion[];
  /** Only rendered for substantial/risky (N8). */
  checklist: ChecklistItem[];
  /** Append-only lines, each already formatted (e.g. `- 2026-11-13: ...`). */
  progressLog: string[];
  nextStep: string;
  scopeChanges: ScopeChangeEntry[];
  verifyRuns: VerifyRun[];
  evidence: EvidenceRef[];
  estadoTarea: TaskEstado;
  /** Rendered "Implementado / Verificado / Pendiente" block, set by close. */
  closeBlock?: string;
  worktreePath?: string;
  /**
   * Repos this task touches (B2). Populated from `open`'s `repos` input when
   * given; used by `close` to evaluate rule 4 (O2) when neither an explicit
   * `repos` nor a derivable basename-of-worktree match is available.
   */
  repos?: string[];
}

// ─── Paths ───────────────────────────────────────────────────────────────────

/** Vault-relative path of the task document for `workItem`. */
export function taskNoteRelPath(workItem: string): string {
  return `tareas/${normalizeWorkItemId(workItem)}.md`;
}

/** Vault-relative directory of a verify/evidence run. */
export function taskEvidenceRelDir(workItem: string, runId: string): string {
  return joinPath('tareas', normalizeWorkItemId(workItem), 'evidencia', runId);
}

// ─── Render ──────────────────────────────────────────────────────────────────

function quoteFm(v: string): string {
  // Minimal, local to task-doc frontmatter: double-quote when the value has
  // characters that would break a simple `key: value` line.
  if (v === '' || /[:#"\n]/.test(v) || v !== v.trim()) {
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return v;
}

function renderCriteriaBlock(criteria: AcceptanceCriterion[]): string {
  return criteria
    .map((ac) => {
      const parts = [`- **${ac.id}** · \`${ac.estado}\` — ${ac.text}`];
      if (ac.evidence.length > 0) {
        parts.push(`· evidencia: ${ac.evidence.map((e) => `[[${e}]]`).join(', ')}`);
      }
      if (ac.reason) parts.push(`· razón: ${ac.reason}`);
      return parts.join(' ');
    })
    .join('\n');
}

function parseCriteriaBlock(body: string): AcceptanceCriterion[] {
  if (body.trim() === '') return [];
  const out: AcceptanceCriterion[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^-\s*\*\*(AC-\d+)\*\*\s*·\s*`([a-z]+)`\s*—\s*(.*)$/);
    if (!m) continue;
    const id = m[1] ?? '';
    const estado = (m[2] ?? 'pendiente') as AcEstado;
    let rest = m[3] ?? '';
    let evidence: string[] = [];
    let reason: string | undefined;
    const evMatch = rest.match(/·\s*evidencia:\s*(.+?)(?:\s*·\s*razón:\s*(.*))?$/);
    const reasonOnlyMatch = rest.match(/·\s*razón:\s*(.*)$/);
    if (evMatch) {
      const evList = evMatch[1] ?? '';
      evidence = [...evList.matchAll(/\[\[([^\]]+)\]\]/g)].map((mm) => mm[1] ?? '');
      if (evMatch[2]) reason = evMatch[2];
      rest = rest.slice(0, rest.indexOf('·')).trim();
    } else if (reasonOnlyMatch) {
      reason = reasonOnlyMatch[1];
      rest = rest.slice(0, rest.indexOf('·')).trim();
    }
    out.push({
      id,
      text: rest,
      estado,
      evidence,
      ...(reason !== undefined && reason !== '' ? { reason } : {}),
    });
  }
  return out;
}

function renderChecklistBlock(items: ChecklistItem[]): string {
  return items.map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}`).join('\n');
}

function parseChecklistBlock(body: string): ChecklistItem[] {
  if (body.trim() === '') return [];
  const out: ChecklistItem[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(/^-\s*\[([ x])\]\s*(.*)$/i);
    if (!m) continue;
    out.push({ done: (m[1] ?? ' ').toLowerCase() === 'x', text: m[2] ?? '' });
  }
  return out;
}

function renderScopeChangesBlock(entries: ScopeChangeEntry[]): string {
  return entries
    .map(
      (e) =>
        `- ${e.date} · ${e.change} · ${e.acId} · ${e.reason} · pedido_por: ${
          e.requestedByUser ? 'usuario' : 'agente'
        }`,
    )
    .join('\n');
}

function parseScopeChangesBlock(body: string): ScopeChangeEntry[] {
  if (body.trim() === '') return [];
  const out: ScopeChangeEntry[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(
      /^-\s*(\S+)\s*·\s*(add|reopen|discard)\s*·\s*(AC-\d+)\s*·\s*(.*?)\s*·\s*pedido_por:\s*(usuario|agente)\s*$/,
    );
    if (!m) continue;
    out.push({
      date: m[1] ?? '',
      change: m[2] as ScopeChangeEntry['change'],
      acId: m[3] ?? '',
      reason: m[4] ?? '',
      requestedByUser: m[5] === 'usuario',
    });
  }
  return out;
}

function renderEvidenceBlock(verifyRuns: VerifyRun[], evidence: EvidenceRef[]): string {
  const lines: string[] = [];
  for (const run of verifyRuns) {
    const headPart = run.head ? ` · head: ${run.head}${run.dirty ? ' (sucio)' : ' (limpio)'}` : '';
    const worktreePart = run.worktreePath ? ` · worktree: ${run.worktreePath}` : '';
    lines.push(`- run: ${run.runId} · ${run.date} · nivel: ${run.level}${headPart}${worktreePart}`);
    for (const cmd of run.commands) {
      const flags = [cmd.timedOut ? 'timeout' : null, cmd.truncated ? 'truncado' : null]
        .filter(Boolean)
        .join(', ');
      const flagsPart = flags ? ` (${flags})` : '';
      const evPart = cmd.evidencePath ? ` · [[${cmd.evidencePath}]]` : '';
      lines.push(`  - ${cmd.name}: exit ${cmd.exitCode}, ${cmd.durationMs}ms${flagsPart}${evPart}`);
    }
  }
  for (const ev of evidence) {
    const linkNote = ev.linkOnly ? ' (solo enlace)' : '';
    lines.push(`- ${ev.kind}: [[${ev.path}]]${linkNote}`);
  }
  return lines.join('\n');
}

/**
 * N1: the exact text of the blocks ONLY chamba is allowed to rewrite
 * (criteria, evidence/verify runs, scope changes) — the input a caller
 * hashes (`services.hash.sha256`, injected; core stays pure/sync) into
 * `chamba_digest`, and recomputes on read to detect a hand-edit of one of
 * these blocks between writes. Deliberately EXCLUDES progress/checklist/
 * next_step/request/close — those are expected to be edited freely (by
 * `update`, or even by hand for progress notes) and aren't the integrity
 * surface this guards.
 */
export function controlledBlocksDigestInput(doc: TaskDoc): string {
  return [
    renderCriteriaBlock(doc.criteria),
    renderEvidenceBlock(doc.verifyRuns, doc.evidence),
    renderScopeChangesBlock(doc.scopeChanges),
  ].join('\u0000');
}

export function renderTaskDoc(doc: TaskDoc, opts: { date: string; digest?: string }): string {
  const fm: string[] = ['---'];
  fm.push(`title: ${quoteFm(`${doc.workItem} — ${doc.title}`)}`);
  fm.push(`date: ${opts.date}`);
  fm.push('type: tarea');
  fm.push(`work_item: ${quoteFm(doc.workItem)}`);
  fm.push('estado: propuesto');
  fm.push(`estado_tarea: ${doc.estadoTarea}`);
  fm.push(`ruta: ${doc.route}`);
  if (doc.worktreePath) fm.push(`worktree_path: ${quoteFm(doc.worktreePath)}`);
  if (doc.repos && doc.repos.length > 0) {
    fm.push(`repos: [${doc.repos.map((r) => quoteFm(r)).join(', ')}]`);
  }
  if (opts.digest) fm.push(`chamba_digest: ${opts.digest}`);
  fm.push('---');

  const sections: string[] = [];
  sections.push(`# ${doc.workItem} — ${doc.title}`);
  sections.push('');
  sections.push('## Pedido');
  sections.push(upsertBlock('', 'request', doc.request).trim());
  sections.push('');
  sections.push('## Criterios de aceptación');
  sections.push(upsertBlock('', 'criteria', renderCriteriaBlock(doc.criteria)).trim());
  sections.push('');
  if (doc.route === 'substantial' || doc.route === 'risky') {
    sections.push('## Checklist');
    sections.push(upsertBlock('', 'checklist', renderChecklistBlock(doc.checklist)).trim());
    sections.push('');
    sections.push('## Progreso');
    sections.push(upsertBlock('', 'progress', doc.progressLog.join('\n')).trim());
    sections.push('');
    sections.push('## Siguiente paso');
    sections.push(upsertBlock('', 'next_step', doc.nextStep).trim());
    sections.push('');
    sections.push('## Cambios de alcance');
    sections.push(
      upsertBlock('', 'scope_changes', renderScopeChangesBlock(doc.scopeChanges)).trim(),
    );
    sections.push('');
  } else {
    // route === 'small': Pedido, AC, Evidencia, Cierre only — but scope_changes
    // still exists as an empty block so scope_change never hits a missing
    // section (NN5).
    sections.push('## Cambios de alcance');
    sections.push(
      upsertBlock('', 'scope_changes', renderScopeChangesBlock(doc.scopeChanges)).trim(),
    );
    sections.push('');
  }
  sections.push('## Evidencia');
  sections.push(
    upsertBlock('', 'evidence', renderEvidenceBlock(doc.verifyRuns, doc.evidence)).trim(),
  );
  sections.push('');
  sections.push('## Cierre');
  sections.push(upsertBlock('', 'close', doc.closeBlock ?? '').trim());
  sections.push('');

  return `${fm.join('\n')}\n\n${sections.join('\n')}`;
}

// ─── Parse ───────────────────────────────────────────────────────────────────

export type ParseTaskDocResult = { doc: TaskDoc; storedDigest?: string } | { error: string };

const FM_SCALAR = (key: string) => new RegExp(`^${key}:\\s*(.*)$`, 'm');

function readFmScalar(md: string, key: string): string | undefined {
  const fmEnd = md.indexOf('\n---', 3);
  const fm = md.startsWith('---') && fmEnd !== -1 ? md.slice(0, fmEnd) : '';
  const m = fm.match(FM_SCALAR(key));
  if (!m) return undefined;
  let v = (m[1] ?? '').trim();
  if (v.startsWith('"') && v.endsWith('"')) {
    v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return v === '' ? undefined : v;
}

function readWrapped(md: string, name: TaskBlockName): string {
  return readBlock(md, name) ?? '';
}

/** Read a bracketed frontmatter array scalar, e.g. `repos: [api, web]`. */
function readFmArray(md: string, key: string): string[] | undefined {
  const fmEnd = md.indexOf('\n---', 3);
  const fm = md.startsWith('---') && fmEnd !== -1 ? md.slice(0, fmEnd) : '';
  const m = fm.match(new RegExp(`^${key}:\\s*\\[(.*)\\]\\s*$`, 'm'));
  if (!m) return undefined;
  const inner = (m[1] ?? '').trim();
  if (inner === '') return [];
  return inner
    .split(',')
    .map((s) => s.trim())
    .map((s) => (s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s))
    .filter((s) => s.length > 0);
}

/**
 * Parse a task document back into a `TaskDoc`. Returns `{error}` only when
 * the structure is unrecoverable (missing work_item/title/route); block
 * bodies are always best-effort (an unparseable line is skipped, never
 * thrown).
 */
export function parseTaskDoc(md: string): ParseTaskDocResult {
  const workItem = readFmScalar(md, 'work_item');
  const route = readFmScalar(md, 'ruta') as TaskRouteProfile | undefined;
  const estadoTarea = (readFmScalar(md, 'estado_tarea') as TaskEstado | undefined) ?? 'abierta';
  const titleLine = readFmScalar(md, 'title') ?? '';
  const title =
    workItem && titleLine.startsWith(`${workItem} — `)
      ? titleLine.slice(`${workItem} — `.length)
      : titleLine;

  if (!workItem) return { error: 'el documento no tiene `work_item` en el frontmatter.' };
  if (route !== 'small' && route !== 'substantial' && route !== 'risky') {
    return { error: `el documento tiene una ruta inválida: "${route}".` };
  }

  const criteria = parseCriteriaBlock(readWrapped(md, 'criteria'));
  const checklist = parseChecklistBlock(readWrapped(md, 'checklist'));
  const progressBody = readWrapped(md, 'progress');
  const progressLog = progressBody === '' ? [] : progressBody.split('\n');
  const nextStep = readWrapped(md, 'next_step');
  const scopeChanges = parseScopeChangesBlock(readWrapped(md, 'scope_changes'));
  const evidenceBody = readWrapped(md, 'evidence');
  const { verifyRuns, evidence } = parseEvidenceBlock(evidenceBody);
  const closeBlock = readWrapped(md, 'close');
  const request = readWrapped(md, 'request');
  const worktreePath = readFmScalar(md, 'worktree_path');
  const repos = readFmArray(md, 'repos');
  const storedDigest = readFmScalar(md, 'chamba_digest');

  return {
    doc: {
      workItem,
      title,
      route,
      request,
      criteria,
      checklist,
      progressLog,
      nextStep,
      scopeChanges,
      verifyRuns,
      evidence,
      estadoTarea,
      ...(closeBlock !== '' ? { closeBlock } : {}),
      ...(worktreePath !== undefined ? { worktreePath } : {}),
      ...(repos !== undefined && repos.length > 0 ? { repos } : {}),
    },
    ...(storedDigest !== undefined ? { storedDigest } : {}),
  };
}

function parseEvidenceBlock(body: string): { verifyRuns: VerifyRun[]; evidence: EvidenceRef[] } {
  const verifyRuns: VerifyRun[] = [];
  const evidence: EvidenceRef[] = [];
  if (body.trim() === '') return { verifyRuns, evidence };

  let current: VerifyRun | undefined;
  for (const line of body.split('\n')) {
    const runMatch = line.match(
      /^-\s*run:\s*(\S+)\s*·\s*(\S+)\s*·\s*nivel:\s*(executed|reported-by-agent)(?:\s*·\s*head:\s*(\S+)\s*\((limpio|sucio)\))?(?:\s*·\s*worktree:\s*(.+?)\s*$)?/,
    );
    if (runMatch) {
      current = {
        runId: runMatch[1] ?? '',
        date: runMatch[2] ?? '',
        level: (runMatch[3] ?? 'executed') as VerifyRun['level'],
        commands: [],
        ...(runMatch[4] ? { head: runMatch[4], dirty: runMatch[5] === 'sucio' } : {}),
        ...(runMatch[6] ? { worktreePath: runMatch[6] } : {}),
      };
      verifyRuns.push(current);
      continue;
    }
    const cmdMatch = line.match(
      /^\s*-\s*([a-z0-9-]+):\s*exit\s*(-?\d+),\s*(\d+)ms(?:\s*\(([^)]*)\))?(?:\s*·\s*\[\[([^\]]+)\]\])?/,
    );
    if (cmdMatch && current) {
      const flags = (cmdMatch[4] ?? '').split(',').map((f) => f.trim());
      current.commands.push({
        name: cmdMatch[1] ?? '',
        exitCode: Number(cmdMatch[2] ?? '0'),
        durationMs: Number(cmdMatch[3] ?? '0'),
        timedOut: flags.includes('timeout'),
        truncated: flags.includes('truncado'),
        ...(cmdMatch[5] ? { evidencePath: cmdMatch[5] } : {}),
      });
      continue;
    }
    const evMatch = line.match(/^-\s*(qa|manual|verify):\s*\[\[([^\]]+)\]\](\s*\(solo enlace\))?/);
    if (evMatch) {
      evidence.push({
        kind: evMatch[1] as EvidenceRef['kind'],
        path: evMatch[2] ?? '',
        ...(evMatch[3] ? { linkOnly: true } : {}),
      });
    }
  }

  return { verifyRuns, evidence };
}
