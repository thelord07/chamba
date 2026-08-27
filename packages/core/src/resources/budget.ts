import type { SystemResources } from '../ports/system.js';

/** Which constraint decided the recommended parallelism. */
export type BudgetLimit = 'memory' | 'cpu' | 'load' | 'cap' | 'requested' | 'overlap';

export interface ConcurrencyBudgetInput {
  resources: SystemResources;
  /** How many workers you'd like to run (e.g. number of repos). */
  requested?: number;
  /** Estimated RAM each parallel worker consumes, in MB. Default 2048 (2 GB). */
  perWorkerMemMB?: number;
  /** RAM held back for the OS/editor/browser, in MB. Default 2048 (2 GB). */
  reservedMemMB?: number;
  /** Hard cap from config (`worktrees.maxParallel`). */
  cap?: number;
}

export interface ConcurrencyBudget {
  /** Safe number of workers to run in parallel — always >= 1. */
  recommended: number;
  /** How many workers memory alone allows. */
  memBudget: number;
  /** How many workers CPU (and current load) allow. */
  cpuBudget: number;
  /** The binding constraint behind `recommended`. */
  limitedBy: BudgetLimit;
  totalMemGB: number;
  freeMemGB: number;
  cpus: number;
  /** One-line human explanation, safe to show verbatim. */
  reason: string;
}

const DEFAULT_PER_WORKER_MB = 2048;
const DEFAULT_RESERVED_MB = 2048;
const BYTES_PER_GB = 1024 ** 3;
const BYTES_PER_MB = 1024 ** 2;

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Compute a safe parallelism budget from machine resources — deterministic,
 * no LLM. The orchestrator consults it before fanning out per-repo workers so a
 * multi-repo `/ticket` doesn't exhaust RAM on an 8/16 GB machine. Conservative
 * on purpose: an OOM is a far worse failure than one fewer worker in parallel.
 */
export function computeConcurrencyBudget(input: ConcurrencyBudgetInput): ConcurrencyBudget {
  const { totalMemBytes, freeMemBytes, cpus, loadAvg1 } = input.resources;
  const perWorker = positive(input.perWorkerMemMB, DEFAULT_PER_WORKER_MB);
  const reserved = nonNegative(input.reservedMemMB, DEFAULT_RESERVED_MB);

  const freeMemMB = freeMemBytes / BYTES_PER_MB;
  const usableMB = freeMemMB - reserved;
  const memBudget = Math.max(1, Math.floor(usableMB / perWorker));

  const cores = Math.max(1, Math.floor(cpus));
  const rawCpuBudget = Math.max(1, cores - 1);
  // Back off when the machine is already busy (loadavg is 0 on Windows → ignored).
  const loadCpuBudget = loadAvg1 > 0 ? Math.max(1, Math.floor(cores - loadAvg1)) : rawCpuBudget;
  const cpuBudget = Math.min(rawCpuBudget, loadCpuBudget);
  const loadBound = loadAvg1 > 0 && loadCpuBudget < rawCpuBudget;

  // Smallest constraint wins; on a tie, machine limits are reported before
  // cap/requested because the machine's ceiling is the more useful story.
  // Seed with memory so `winner` is always defined, then fold in the rest.
  let winner: { by: BudgetLimit; n: number } = { by: 'memory', n: memBudget };
  const rest: Array<{ by: BudgetLimit; n: number }> = [
    { by: loadBound ? 'load' : 'cpu', n: cpuBudget },
  ];
  if (input.cap != null) rest.push({ by: 'cap', n: Math.max(1, Math.floor(input.cap)) });
  if (input.requested != null) {
    rest.push({ by: 'requested', n: Math.max(1, Math.floor(input.requested)) });
  }
  for (const c of rest) {
    if (c.n < winner.n) winner = c;
  }
  const recommended = Math.max(1, winner.n);

  const totalMemGB = round1(totalMemBytes / BYTES_PER_GB);
  const freeMemGB = round1(freeMemBytes / BYTES_PER_GB);
  const workers = recommended === 1 ? 'worker' : 'workers';
  const reason =
    `${totalMemGB} GB RAM (${freeMemGB} GB free), ${cores} cores → up to ${recommended} ` +
    `parallel ${workers} (limited by ${explain(winner.by, { perWorker, reserved, cores, loadAvg1, cap: input.cap, requested: input.requested })})`;

  return {
    recommended,
    memBudget,
    cpuBudget,
    limitedBy: winner.by,
    totalMemGB,
    freeMemGB,
    cpus: cores,
    reason,
  };
}

function explain(
  by: BudgetLimit,
  ctx: {
    perWorker: number;
    reserved: number;
    cores: number;
    loadAvg1: number;
    cap?: number;
    requested?: number;
  },
): string {
  switch (by) {
    case 'memory':
      return `memory (~${round1(ctx.perWorker / 1024)} GB/worker, ${round1(ctx.reserved / 1024)} GB reserved)`;
    case 'cpu':
      return `CPU (${ctx.cores} cores, one left for the OS)`;
    case 'load':
      return `load (${round1(ctx.loadAvg1)} on ${ctx.cores} cores)`;
    case 'cap':
      return `config cap (worktrees.maxParallel=${ctx.cap})`;
    case 'requested':
      return `what you asked for (${ctx.requested})`;
    case 'overlap':
      return 'overlapping files across worktrees';
  }
}

function positive(value: number | undefined, fallback: number): number {
  return value != null && value > 0 ? value : fallback;
}

function nonNegative(value: number | undefined, fallback: number): number {
  return value != null && value >= 0 ? value : fallback;
}

/**
 * Cap a RAM/CPU budget by observed file overlap. If two worktrees share files,
 * they must not run in the same wave — `maxWaveSize` is the largest set of
 * non-overlapping workers. Never drops below 1.
 */
export function applyOverlapCap(
  budget: ConcurrencyBudget,
  maxWaveSize: number,
  overlapCount: number,
): ConcurrencyBudget {
  const n = Math.max(1, Math.floor(maxWaveSize));
  if (overlapCount <= 0 || n >= budget.recommended) return budget;
  const workers = n === 1 ? 'worker' : 'workers';
  return {
    ...budget,
    recommended: n,
    limitedBy: 'overlap',
    reason:
      `${budget.reason} Then capped to ${n} parallel ${workers} ` +
      `(${overlapCount} overlapping file pair${overlapCount === 1 ? '' : 's'}).`,
  };
}
