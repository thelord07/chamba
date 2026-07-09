import { describe, expect, it } from 'vitest';
import type { SystemResources } from '../ports/system.js';
import { computeConcurrencyBudget } from './budget.js';

const GB = 1024 ** 3;

function res(over: Partial<SystemResources> = {}): SystemResources {
  return { totalMemBytes: 16 * GB, freeMemBytes: 8 * GB, cpus: 8, loadAvg1: 0, ...over };
}

describe('computeConcurrencyBudget', () => {
  it('is conservative on a small machine (memory-limited)', () => {
    const b = computeConcurrencyBudget({
      resources: res({ totalMemBytes: 8 * GB, freeMemBytes: 5 * GB, cpus: 4 }),
    });
    expect(b.recommended).toBe(1); // (5 - 2 reserved) / 2 GB per worker → 1
    expect(b.limitedBy).toBe('memory');
    expect(b.reason).toContain('GB RAM');
    expect(b.reason).toContain('parallel');
  });

  it('scales up on a big machine, capped by CPU', () => {
    const b = computeConcurrencyBudget({
      resources: res({ totalMemBytes: 64 * GB, freeMemBytes: 40 * GB, cpus: 16 }),
    });
    expect(b.recommended).toBe(15); // 16 cores, one reserved
    expect(b.limitedBy).toBe('cpu');
  });

  it('never recommends more than you asked for', () => {
    const b = computeConcurrencyBudget({
      resources: res({ totalMemBytes: 64 * GB, freeMemBytes: 40 * GB, cpus: 16 }),
      requested: 5,
    });
    expect(b.recommended).toBe(5);
    expect(b.limitedBy).toBe('requested');
  });

  it('backs off under high load', () => {
    const b = computeConcurrencyBudget({
      resources: res({ totalMemBytes: 32 * GB, freeMemBytes: 20 * GB, cpus: 16, loadAvg1: 16 }),
    });
    expect(b.recommended).toBe(1);
    expect(b.limitedBy).toBe('load');
  });

  it('honors the config cap even with RAM to spare', () => {
    const b = computeConcurrencyBudget({
      resources: res({ totalMemBytes: 32 * GB, freeMemBytes: 20 * GB, cpus: 16 }),
      cap: 2,
    });
    expect(b.recommended).toBe(2);
    expect(b.limitedBy).toBe('cap');
  });

  it('respects a custom per-worker estimate', () => {
    const big = computeConcurrencyBudget({
      resources: res({ freeMemBytes: 10 * GB, cpus: 16 }),
      perWorkerMemMB: 4096,
    });
    const small = computeConcurrencyBudget({
      resources: res({ freeMemBytes: 10 * GB, cpus: 16 }),
      perWorkerMemMB: 1024,
    });
    expect(small.recommended).toBeGreaterThan(big.recommended);
  });

  it('never drops below 1, even with no free memory', () => {
    const b = computeConcurrencyBudget({ resources: res({ freeMemBytes: 0, cpus: 4 }) });
    expect(b.recommended).toBe(1);
  });

  it('reports rounded GB and core count', () => {
    const b = computeConcurrencyBudget({
      resources: res({ totalMemBytes: 16 * GB, freeMemBytes: 8 * GB, cpus: 10 }),
    });
    expect(b.totalMemGB).toBe(16);
    expect(b.freeMemGB).toBe(8);
    expect(b.cpus).toBe(10);
  });
});
