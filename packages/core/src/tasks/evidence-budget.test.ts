import { describe, expect, it } from 'vitest';
import { DEFAULT_EVIDENCE_BUDGET, planEvidenceCopy } from './evidence-budget.js';

describe('planEvidenceCopy', () => {
  it('copies everything under all three limits', () => {
    const plan = planEvidenceCopy([
      { path: 'a.md', sizeBytes: 1_000, kind: 'text' },
      { path: 'b.png', sizeBytes: 1_000_000, kind: 'image' },
    ]);
    expect(plan.copy).toHaveLength(2);
    expect(plan.linkOnly).toHaveLength(0);
  });

  it('links a 3 MB image (over the 2 MB/image limit) with an explicit reason', () => {
    const plan = planEvidenceCopy([{ path: 'big.png', sizeBytes: 3 * 1024 * 1024, kind: 'image' }]);
    expect(plan.copy).toHaveLength(0);
    expect(plan.linkOnly).toHaveLength(1);
    expect(plan.linkOnly[0]?.reason).toMatch(/imagen/);
  });

  it('cuts off and links the rest once the 20 MB/run budget is exhausted', () => {
    const files = [
      { path: 'a.md', sizeBytes: 15 * 1024 * 1024, kind: 'text' as const },
      { path: 'b.md', sizeBytes: 10 * 1024 * 1024, kind: 'text' as const },
    ];
    const plan = planEvidenceCopy(files);
    expect(plan.copy.map((f) => f.path)).toEqual(['a.md']);
    expect(plan.linkOnly.map((f) => f.path)).toEqual(['b.md']);
    expect(plan.linkOnly[0]?.reason).toMatch(/run/);
  });

  it('copies at most 200 files/run, linking the 201st+ (500-file criterion)', () => {
    const files = Array.from({ length: 500 }, (_, i) => ({
      path: `f${i}.md`,
      sizeBytes: 10,
      kind: 'text' as const,
    }));
    const plan = planEvidenceCopy(files);
    expect(plan.copy).toHaveLength(200);
    expect(plan.linkOnly).toHaveLength(300);
  });

  it('respects custom limits', () => {
    const plan = planEvidenceCopy([{ path: 'a.md', sizeBytes: 100, kind: 'text' }], {
      ...DEFAULT_EVIDENCE_BUDGET,
      maxFiles: 0,
    });
    expect(plan.copy).toHaveLength(0);
    expect(plan.linkOnly).toHaveLength(1);
  });
});
