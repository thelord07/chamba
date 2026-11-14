/**
 * tasks/verify-runner.ts — CHAMBA-022 (C3)
 *
 * Resolves `verify` commands (B9: ONLY `<homedir>/.chamba/config.json` and
 * `<wsRoot>/.chamba/config.json` — never a repo's own config), runs them
 * via `ProcessPort.run` with an explicit env (O7) and a hard timeout
 * (B5/tree-kill lives in the adapter), captures `head`/`dirty` (N1), and
 * redacts + gates every command's output before it is ever written
 * anywhere (§2.4 of the plan).
 *
 * Never writes to the vault itself — that's `tasks/task-store.ts`'s job
 * (called from `tools/task.ts`, which decides whether there IS a vault/doc
 * to persist evidence into, O6).
 */

import {
  assertNotUnsupportedPath,
  detectGitRepos,
  detectStyle,
  isAbsoluteLocal,
  isUnderLocal,
  joinPath,
  localDirname,
  parseChambaConfig,
  type ReposConfig,
  redactSecretValues,
  renderVerifyEvidence,
  renderVerifySummaryBlock,
  resolveVerifyCommands,
  tailRing,
  type VerifyCommandConfig,
  type VerifyRun,
  type VerifyRunCommandResult,
  WORKSPACE_DIR,
} from '@chamba/core';
import { resolveWsRoot } from '../parche/resolve-ws-root.js';
import type { Services } from '../services.js';
import { secretWriteGate } from '../write-gate.js';

const CONFIG_FILE = `${WORKSPACE_DIR}/config.json`;

/** NN2: fixtures emit on a single stream (stdout) to avoid flaky interleaving. */
const CAPTURE = { tailLines: 200, maxBytes: 256 * 1024 };

/** O7 default allowlist — the mcp package ALWAYS builds this explicitly, never leaves `env` unset. */
const ENV_ALLOWLIST_EXACT = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'TMPDIR',
  'ComSpec',
  'PATHEXT',
  'LANG',
  'LC_ALL',
  'TZ',
  'CI',
]);
const ENV_ALLOWLIST_PREFIXES = ['NODE_', 'npm_config_'];

function allowlistEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (ENV_ALLOWLIST_EXACT.has(key) || ENV_ALLOWLIST_PREFIXES.some((p) => key.startsWith(p))) {
      out[key] = value;
    }
  }
  return out;
}

/** O7: allowlist + `cmd.env` (escape hatch); `inheritEnv: true` is opt-in per command. */
function buildCommandEnv(cmd: VerifyCommandConfig): Record<string, string> {
  const base = cmd.inheritEnv
    ? (Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)) as Record<
        string,
        string
      >)
    : allowlistEnv();
  return { ...base, ...(cmd.env ?? {}) };
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

export interface VerifyCommandOutcome {
  name: string;
  exitCode: number;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  /**
   * Already redacted (`redactSecretValues`) combined stdout+stderr tail, OR
   * (if `secretWriteGate` still found something after redaction) a retained
   * notice — NEVER the raw text in that case. Not yet persisted to disk;
   * the caller (task.ts) decides where (or whether) to write it.
   */
  evidenceBody: string;
  retained: boolean;
}

export type RunVerifyResult =
  | {
      ok: true;
      run: VerifyRun;
      outcomes: VerifyCommandOutcome[];
      summaryBlock: string;
    }
  | { ok: false; error: string };

export interface RunVerifyInput {
  services: Services;
  worktreePath: string;
  /** Optional filter over the workspace's repo map (N11) — never introduces a new repo. */
  repos?: string[];
  date: string;
}

/**
 * Realpath-contain `candidate` under `root` (both already absolute).
 *
 * B5: uses `isUnderLocal` (detectStyle + caseFoldLocal, separator-aware) —
 * NEVER a bare POSIX `startsWith('/')` — so this holds on win32 too.
 * `strict: true` (B7) rejects `candidate === root` exactly — used when
 * `root` must be a strict ancestor (the worktree can't BE the workspace
 * root); the default (loose) is used for `cmd.cwd`, which may legitimately
 * equal the worktree root itself.
 */
async function isContained(
  services: Services,
  root: string,
  candidate: string,
  opts: { strict?: boolean } = {},
): Promise<{ ok: true; real: string } | { ok: false }> {
  try {
    const realRoot = await services.fs.realpath(root);
    const realCandidate = await services.fs.realpath(candidate);
    const style = detectStyle(services.platform);
    if (isUnderLocal(realRoot, realCandidate, style, opts)) {
      return { ok: true, real: realCandidate };
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

export async function runVerify(input: RunVerifyInput): Promise<RunVerifyResult> {
  const { services, worktreePath, date } = input;

  // NN1: explicit guard — a plain `exec()`-only adapter can't support verify.
  if (typeof services.process.run !== 'function') {
    return {
      ok: false,
      error:
        'este adapter no soporta ejecución con timeout; verify no está disponible (ProcessPort.run no está implementado).',
    };
  }

  if (!worktreePath.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(worktreePath)) {
    return { ok: false, error: `worktreePath debe ser una ruta absoluta: "${worktreePath}".` };
  }
  if (!(await services.fs.exists(worktreePath))) {
    return { ok: false, error: `worktreePath no existe: "${worktreePath}".` };
  }

  const wsRoot = await resolveWsRoot(services);
  // N7/NN4/B7: worktreePath must resolve under the workspace root, STRICTLY
  // — the worktree can never BE the workspace root itself (a worktree that
  // equals wsRoot would make the "global+project only" config isolation of
  // B9 meaningless: an attacker-controlled worktree could host the project
  // config layer that `verify` trusts).
  const containment = await isContained(services, wsRoot, worktreePath, { strict: true });
  if (!containment.ok) {
    return {
      ok: false,
      error: `worktreePath "${worktreePath}" no está contenido (estrictamente) en el workspace resuelto (${wsRoot}).`,
    };
  }
  const realWorktreePath = containment.real;

  // B7: defense-in-depth — even after the strict containment check above,
  // make sure the project config layer we're about to trust doesn't itself
  // live inside the worktree (would mean `resolveWsRoot` resolved oddly).
  const style = detectStyle(services.platform);
  const projectConfigPath = joinPath(wsRoot, CONFIG_FILE);
  const projectConfigDirReal = await (async () => {
    try {
      return await services.fs.realpath(localDirname(projectConfigPath, style));
    } catch {
      return localDirname(projectConfigPath, style);
    }
  })();
  if (isUnderLocal(realWorktreePath, projectConfigDirReal, style)) {
    return {
      ok: false,
      error: `la configuración del workspace (${projectConfigPath}) quedaría dentro del worktree (${realWorktreePath}); resolveWsRoot parece mal configurado.`,
    };
  }

  // B9: ONLY these two layers, NEVER the worktree's own .chamba/config.json.
  const globalLayer = await readReposLayer(services, joinPath(services.homedir, CONFIG_FILE));
  const projectLayer = await readReposLayer(services, joinPath(wsRoot, CONFIG_FILE));
  const layers: Array<ReposConfig | undefined> = [globalLayer, projectLayer];

  // N11: repos come from the workspace map; `repos` only FILTERS it.
  const allRepos = await detectGitRepos(services.fs, wsRoot);
  let reposToRun = allRepos;
  if (input.repos && input.repos.length > 0) {
    const unknown = input.repos.filter((r) => !allRepos.includes(r));
    if (unknown.length > 0) {
      return {
        ok: false,
        error: `repo(s) desconocido(s) en el mapa del workspace: ${unknown.join(', ')}. Repos válidos: ${
          allRepos.join(', ') || '(ninguno detectado)'
        }.`,
      };
    }
    reposToRun = input.repos;
  }

  const plan: Array<{ repo: string; cmd: VerifyCommandConfig }> = [];
  for (const repo of reposToRun) {
    for (const cmd of resolveVerifyCommands(layers, repo)) {
      plan.push({ repo, cmd });
    }
  }

  // N1: head/dirty via ProcessPort.exec, no shell.
  let head: string | undefined;
  let dirty: boolean | undefined;
  try {
    const headRes = await services.process.exec('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: realWorktreePath,
    });
    if (headRes.exitCode === 0) head = headRes.stdout.trim();
    const statusRes = await services.process.exec('git', ['status', '--porcelain'], {
      cwd: realWorktreePath,
    });
    if (statusRes.exitCode === 0) dirty = statusRes.stdout.trim().length > 0;
  } catch {
    // not a git repo, or git unavailable — head/dirty simply absent
  }

  if (plan.length === 0) {
    const run: VerifyRun = {
      runId: '',
      date,
      commands: [],
      level: 'reported-by-agent',
      ...(head !== undefined ? { head } : {}),
      ...(dirty !== undefined ? { dirty } : {}),
    };
    return { ok: true, run, outcomes: [], summaryBlock: renderVerifySummaryBlock(run) };
  }

  const outcomes: VerifyCommandOutcome[] = [];
  const commandResults: VerifyRunCommandResult[] = [];

  for (const { cmd } of plan) {
    // NN4: cmd.cwd validated directly (assertNotUnsupportedPath/isAbsoluteLocal)
    // on top of the realpath containment below.
    let cwdAbs = realWorktreePath;
    if (cmd.cwd) {
      try {
        assertNotUnsupportedPath(cmd.cwd, 'win32');
      } catch (err) {
        commandResults.push({
          name: cmd.name,
          exitCode: 1,
          timedOut: false,
          truncated: false,
          durationMs: 0,
        });
        outcomes.push({
          name: cmd.name,
          exitCode: 1,
          timedOut: false,
          truncated: false,
          durationMs: 0,
          evidenceBody: `cwd inválido: ${err instanceof Error ? err.message : String(err)}`,
          retained: false,
        });
        continue;
      }
      if (isAbsoluteLocal(cmd.cwd, 'win32')) {
        commandResults.push({
          name: cmd.name,
          exitCode: 1,
          timedOut: false,
          truncated: false,
          durationMs: 0,
        });
        outcomes.push({
          name: cmd.name,
          exitCode: 1,
          timedOut: false,
          truncated: false,
          durationMs: 0,
          evidenceBody: `cwd debe ser relativo al worktree: "${cmd.cwd}".`,
          retained: false,
        });
        continue;
      }
      cwdAbs = joinPath(realWorktreePath, cmd.cwd);
    }

    const cwdContainment = await isContained(services, realWorktreePath, cwdAbs);
    if (!cwdContainment.ok) {
      commandResults.push({
        name: cmd.name,
        exitCode: 1,
        timedOut: false,
        truncated: false,
        durationMs: 0,
      });
      outcomes.push({
        name: cmd.name,
        exitCode: 1,
        timedOut: false,
        truncated: false,
        durationMs: 0,
        evidenceBody: `cwd "${cmd.cwd}" sale del worktree.`,
        retained: false,
      });
      continue;
    }

    const env = buildCommandEnv(cmd);
    // biome-ignore lint/style/noNonNullAssertion: guarded by the NN1 check above
    const result = await services.process.run!(cmd.command, cmd.args, {
      cwd: cwdContainment.real,
      timeoutMs: cmd.timeoutSec * 1000,
      env,
      capture: CAPTURE,
    });

    const rawTail = `${result.stdout}${result.stderr}`;
    const ring = tailRing([rawTail], { lines: CAPTURE.tailLines, maxBytes: CAPTURE.maxBytes });
    const redacted = redactSecretValues(ring.text);

    const gate = await secretWriteGate(services.hash, [
      { field: `verify:${cmd.name}`, value: redacted },
    ]);
    let evidenceBody: string;
    let retained = false;
    if (gate.blocked) {
      retained = true;
      evidenceBody = `[evidencia retenida: el escáner detectó hallazgos tras redactar]`;
    } else {
      evidenceBody = redacted;
    }

    const truncated = result.truncated === true || ring.truncated;
    commandResults.push({
      name: cmd.name,
      exitCode: result.exitCode,
      timedOut: result.timedOut === true,
      truncated,
      durationMs: result.durationMs,
    });
    outcomes.push({
      name: cmd.name,
      exitCode: result.exitCode,
      timedOut: result.timedOut === true,
      truncated,
      durationMs: result.durationMs,
      evidenceBody,
      retained,
    });
  }

  const run: VerifyRun = {
    runId: '',
    date,
    commands: commandResults,
    level: 'executed',
    ...(head !== undefined ? { head } : {}),
    ...(dirty !== undefined ? { dirty } : {}),
  };

  return { ok: true, run, outcomes, summaryBlock: renderVerifySummaryBlock(run) };
}

/** Render the per-command evidence markdown for a single outcome (caller writes it to disk). */
export function renderOutcomeEvidence(
  outcome: VerifyCommandOutcome,
  run: Pick<VerifyRun, 'head' | 'dirty'>,
): string {
  return renderVerifyEvidence({
    name: outcome.name,
    exitCode: outcome.exitCode,
    durationMs: outcome.durationMs,
    timedOut: outcome.timedOut,
    truncated: outcome.truncated,
    ...(run.head !== undefined ? { head: run.head } : {}),
    ...(run.dirty !== undefined ? { dirty: run.dirty } : {}),
    tail: outcome.evidenceBody,
  });
}
