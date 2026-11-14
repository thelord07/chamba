import { describe, expect, it } from 'vitest';
import type { VerifyRun } from './task-doc.js';
import { renderVerifyEvidence, renderVerifySummaryBlock, tailRing } from './verify-evidence.js';

describe('tailRing', () => {
  it('keeps everything when under both limits', () => {
    const result = tailRing(['line1\n', 'line2\n'], { lines: 200, maxBytes: 1024 });
    expect(result).toEqual({ text: 'line1\nline2\n', truncated: false });
  });

  it('keeps only the last N lines when over the line limit', () => {
    const chunks = Array.from({ length: 10 }, (_, i) => `line${i}\n`);
    const result = tailRing(chunks, { lines: 3, maxBytes: 1024 });
    expect(result.text).toBe('line7\nline8\nline9\n');
    expect(result.truncated).toBe(true);
  });

  it('(B4) > 4 MiB of output with exit 0 ⇒ truncated, and the LAST line survives', () => {
    const bigChunk = 'x'.repeat(5 * 1024 * 1024);
    const chunks = [bigChunk, '\nlast-line-marker\n'];
    const result = tailRing(chunks, { lines: 200, maxBytes: 256 * 1024 });
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('last-line-marker');
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(256 * 1024);
  });

  it('returns empty, non-truncated for no output', () => {
    expect(tailRing([], { lines: 200, maxBytes: 1024 })).toEqual({ text: '', truncated: false });
  });

  it('keeps a byte-truncated fragment of the single last line when it alone exceeds maxBytes', () => {
    const result = tailRing(['a'.repeat(1000)], { lines: 200, maxBytes: 10 });
    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(result.text).byteLength).toBeLessThanOrEqual(10);
    expect(result.text.length).toBeGreaterThan(0);
  });
});

describe('renderVerifyEvidence', () => {
  it('never includes argv — only `name`, exit code, duration, flags', () => {
    const md = renderVerifyEvidence({
      name: 'unit',
      exitCode: 1,
      durationMs: 1234,
      timedOut: false,
      truncated: false,
      head: 'abc1234',
      dirty: false,
      tail: 'FAIL some/test.ts',
    });
    expect(md).toContain('exit code: 1');
    expect(md).toContain('head: abc1234');
    expect(md).toContain('árbol: limpio');
    expect(md).toContain('FAIL some/test.ts');
    expect(md).not.toMatch(/\/Users\//);
  });

  it('uses a defensive fence longer than any backtick run in the content', () => {
    const md = renderVerifyEvidence({
      name: 'unit',
      exitCode: 0,
      durationMs: 1,
      timedOut: false,
      truncated: false,
      tail: 'contiene ```js backticks``` en la salida',
    });
    expect(md).toContain('````');
  });
});

describe('renderVerifySummaryBlock', () => {
  it('reports the weaker "reported-by-agent" level explicitly', () => {
    const run: VerifyRun = {
      runId: 'run-1',
      date: '2026-11-13',
      level: 'reported-by-agent',
      commands: [],
    };
    expect(renderVerifySummaryBlock(run)).toMatch(/reportado por el agente/);
  });

  it('summarizes ok/failed counts without raw output', () => {
    const run: VerifyRun = {
      runId: 'run-1',
      date: '2026-11-13',
      level: 'executed',
      head: 'abc1234',
      dirty: true,
      commands: [
        { name: 'unit', exitCode: 0, timedOut: false, truncated: false, durationMs: 10 },
        { name: 'lint', exitCode: 1, timedOut: false, truncated: false, durationMs: 5 },
      ],
    };
    const summary = renderVerifySummaryBlock(run);
    expect(summary).toContain('1/2 comando(s) OK');
    expect(summary).toContain('lint');
    expect(summary).toContain('sucio');
  });
});
