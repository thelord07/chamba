import { describe, expect, it } from 'vitest';
import { FakeProcess } from '../testing/fake-process.js';
import { GitDetector } from './git-detector.js';

describe('GitDetector', () => {
  it('returns true inside a work tree', async () => {
    const fp = new FakeProcess(() => ({ stdout: 'true\n', exitCode: 0 }));
    expect(await new GitDetector(fp).isGitRepo('/repo')).toBe(true);
  });

  it('returns false when git reports an error', async () => {
    const fp = new FakeProcess(() => ({ stderr: 'not a git repository', exitCode: 128 }));
    expect(await new GitDetector(fp).isGitRepo('/tmp')).toBe(false);
  });

  it('caches the result per root', async () => {
    const fp = new FakeProcess(() => ({ stdout: 'true', exitCode: 0 }));
    const detector = new GitDetector(fp);
    await detector.isGitRepo('/repo');
    await detector.isGitRepo('/repo');
    expect(fp.calls).toHaveLength(1);
  });
});
