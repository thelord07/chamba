import { describe, expect, it } from 'vitest';
import { FakeProcess } from './fake-process.js';

describe('FakeProcess.exec', () => {
  it('records calls and returns handler output (default: exit 0, empty)', async () => {
    const proc = new FakeProcess();
    const result = await proc.exec('git', ['status'], { cwd: '/repo' });
    expect(result).toEqual({ stdout: '', stderr: '', exitCode: 0 });
    expect(proc.calls).toEqual([{ command: 'git', args: ['status'], cwd: '/repo' }]);
  });
});

describe('FakeProcess.run (CHAMBA-022, B1)', () => {
  it('records run calls separately from exec calls', async () => {
    const proc = new FakeProcess();
    const result = await proc.run('node', ['test.js'], { timeoutMs: 1000 });
    expect(result).toEqual({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 });
    expect(proc.runCalls).toEqual([{ command: 'node', args: ['test.js'], cwd: undefined }]);
    expect(proc.calls).toEqual([]);
  });

  it('lets the handler simulate a timeout/truncated run', async () => {
    const proc = new FakeProcess(
      () => ({}),
      () => ({ exitCode: 0, timedOut: true, truncated: true, signal: 'SIGKILL', durationMs: 5000 }),
    );
    const result = await proc.run('node', ['hang.js']);
    expect(result).toEqual({
      stdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: 5000,
      timedOut: true,
      truncated: true,
      signal: 'SIGKILL',
    });
  });
});
