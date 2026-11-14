/**
 * node-process.test.ts — CHAMBA-022, `NodeProcess.run` (Test 2 of the ticket's §4)
 *
 * Fixtures under `./fixtures/*.js` are plain, portable `node <script>.js`
 * scripts (no shell, no OS-specific syntax) so these tests behave the same
 * on ubuntu/windows/macOS.
 */
import { readFileSync, rmSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NodeProcess } from './node-process.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => join(here, 'fixtures', name);

let proc: NodeProcess;
let workDir: string;

beforeEach(async () => {
  proc = new NodeProcess();
  workDir = await mkdtemp(join(tmpdir(), 'chamba-run-test-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe('NodeProcess.run — exit codes', () => {
  it('exit 0', async () => {
    const result = await proc.run('node', [fixture('exit-code.js'), '0']);
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBeUndefined();
  });

  it('exit 1', async () => {
    const result = await proc.run('node', [fixture('exit-code.js'), '1']);
    expect(result.exitCode).toBe(1);
  });
});

describe('NodeProcess.run — args arrive literal, never shell-interpreted', () => {
  it('args with spaces and literal ";" survive untouched (no injection)', async () => {
    const args = ['a b', ';', 'echo PWNED'];
    const result = await proc.run('node', [fixture('echo-args.js'), ...args]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual(args);
    expect(result.stdout).not.toContain('PWNED\n'); // never actually executed as a command
  });
});

describe('NodeProcess.run — timeout + tree-kill (B5)', () => {
  it('kills the direct process AND a grandchild it spawned', async () => {
    const pidFile = join(workDir, 'grandchild.pid');
    const result = await proc.run('node', [fixture('hang-with-grandchild.js'), pidFile], {
      timeoutMs: 300,
      capture: { tailLines: 10, maxBytes: 1024 },
    });
    expect(result.timedOut).toBe(true);

    // Give the grandchild's death a brief moment to be reflected by the OS,
    // then confirm it's actually gone — not just the direct child.
    await new Promise((r) => setTimeout(r, 4500));
    const grandchildPid = Number(readFileSync(pidFile, 'utf8').trim());
    let alive = true;
    try {
      process.kill(grandchildPid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 15_000);
});

describe('NodeProcess.run — B4: output over the cap still exits normally', () => {
  it('> 4 MiB of output with exit 0 ⇒ exitCode 0, truncated, last line present', async () => {
    const result = await proc.run('node', [fixture('big-output.js')], {
      capture: { tailLines: 200, maxBytes: 256 * 1024 },
    });
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.timedOut).toBeUndefined();
    expect(result.stdout).toContain('LAST-LINE-MARKER');
    expect(new TextEncoder().encode(result.stdout).byteLength).toBeLessThanOrEqual(256 * 1024);
  }, 20_000);
});
