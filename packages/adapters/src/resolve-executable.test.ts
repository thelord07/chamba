/**
 * resolve-executable.test.ts — CHAMBA-022 (O4)
 *
 * Deterministic: `platform`/`env`/`exists` are injected so Windows-specific
 * behaviour (the `.cmd`/`.bat` → `cmd.exe` branch, `PATHEXT`) is exercised
 * from any OS, without needing a real Windows machine.
 */
import { describe, expect, it } from 'vitest';
import { resolveExecutable, UnsafeArgError } from './resolve-executable.js';

const posixDeps = { platform: 'linux' as NodeJS.Platform, env: { PATH: '/usr/bin' } };

describe('resolveExecutable — POSIX', () => {
  it('resolves a bare command via PATH', () => {
    const exists = (p: string) => p === '/usr/bin/node';
    const result = resolveExecutable('node', ['script.js'], '/repo', { ...posixDeps, exists });
    expect(result).toEqual({ file: '/usr/bin/node', args: ['script.js'], viaComSpec: false });
  });

  it('prefers node_modules/.bin over PATH', () => {
    const exists = (p: string) => p === '/repo/node_modules/.bin/vitest' || p === '/usr/bin/vitest';
    const result = resolveExecutable('vitest', [], '/repo', { ...posixDeps, exists });
    expect(result.file).toBe('/repo/node_modules/.bin/vitest');
  });

  it('resolves a path-like command against cwd', () => {
    const exists = () => true;
    const result = resolveExecutable('./scripts/test.sh', [], '/repo', { ...posixDeps, exists });
    expect(result.file).toBe('/repo/scripts/test.sh');
    expect(result.viaComSpec).toBe(false);
  });

  it('falls back to the bare command when nothing resolves (spawn will ENOENT clearly)', () => {
    const exists = () => false;
    const result = resolveExecutable('ghost', [], '/repo', { ...posixDeps, exists });
    expect(result.file).toBe('ghost');
  });

  it('never routes through cmd.exe on POSIX, even for a name ending in .cmd', () => {
    const exists = (p: string) => p === '/usr/bin/weird.cmd';
    const result = resolveExecutable('weird.cmd', [], '/repo', { ...posixDeps, exists });
    expect(result.viaComSpec).toBe(false);
  });
});

const winDeps = {
  platform: 'win32' as NodeJS.Platform,
  env: {
    PATH: 'C:\\bin',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  },
};

describe('resolveExecutable — Windows (.cmd/.bat via cmd.exe, O4)', () => {
  it('resolves PATHEXT candidates in order and routes a .cmd through cmd.exe /d /s /c', () => {
    const exists = (p: string) => p === 'C:\\bin\\pnpm.CMD';
    const result = resolveExecutable('pnpm', ['test'], 'C:\\repo', { ...winDeps, exists });
    expect(result).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'C:\\bin\\pnpm.CMD', 'test'],
      viaComSpec: true,
    });
  });

  it('never uses shell:true-style behaviour — ComSpec branch has an explicit, validated argv', () => {
    const exists = (p: string) => p === 'C:\\bin\\pnpm.CMD';
    const result = resolveExecutable('pnpm', ['test', '--filter=@x/y'], 'C:\\repo', {
      ...winDeps,
      exists,
    });
    // N12: every element is its OWN argv entry — never a single concatenated
    // shell string (`args.join(' ')` would collapse this into one command
    // line, which is exactly the `shell: true` shape this resolver avoids).
    expect(result.args).toEqual(['/d', '/s', '/c', 'C:\\bin\\pnpm.CMD', 'test', '--filter=@x/y']);
    for (const token of result.args) {
      expect(typeof token).toBe('string');
    }
  });

  it('(O4) rejects an arg with a disallowed character for the .cmd branch — ALLOWLIST, not denylist', () => {
    const exists = (p: string) => p === 'C:\\bin\\pnpm.CMD';
    expect(() =>
      resolveExecutable('pnpm', ['test', '&& calc.exe'], 'C:\\repo', { ...winDeps, exists }),
    ).toThrow(UnsafeArgError);
  });

  it('accepts the allowed character set (alnum, . _ : \\ / @ = + - and space)', () => {
    const exists = (p: string) => p === 'C:\\bin\\pnpm.CMD';
    expect(() =>
      resolveExecutable(
        'pnpm',
        ['run', 'test:unit', '--filter=@x/y', '-- --timeout=5000'],
        'C:\\repo',
        {
          ...winDeps,
          exists,
        },
      ),
    ).not.toThrow();
  });

  it('a .exe target is spawned directly, never through cmd.exe', () => {
    const exists = (p: string) => p === 'C:\\bin\\node.EXE';
    const result = resolveExecutable('node', ['script.js'], 'C:\\repo', { ...winDeps, exists });
    expect(result.viaComSpec).toBe(false);
    expect(result.file).toBe('C:\\bin\\node.EXE');
  });

  it('(N8) rejects a resolved .cmd/.bat FILE path with a disallowed character — not just args', () => {
    // A cwd-derived path that slipped a cmd.exe metacharacter past resolution
    // (e.g. an attacker-influenced worktree dir name) must be caught here,
    // not just in `args` — it is the FIRST token cmd.exe reads after `/c`.
    const exists = (p: string) => p === 'C:\\repo&calc\\pnpm.cmd';
    expect(() =>
      resolveExecutable('.\\pnpm.cmd', ['test'], 'C:\\repo&calc', { ...winDeps, exists }),
    ).toThrow(UnsafeArgError);
  });

  it('(N8) the exact built argv line for cmd.exe — file, flags and args all literal, never concatenated into one string', () => {
    const exists = (p: string) => p === 'C:\\bin\\pnpm.CMD';
    const result = resolveExecutable('pnpm', ['run', 'build'], 'C:\\repo', { ...winDeps, exists });
    expect(result).toEqual({
      file: 'C:\\Windows\\System32\\cmd.exe',
      args: ['/d', '/s', '/c', 'C:\\bin\\pnpm.CMD', 'run', 'build'],
      viaComSpec: true,
    });
    // Every element of argv is a separate array entry — no shell string was
    // built by concatenation anywhere in this result.
    for (const token of result.args) {
      expect(typeof token).toBe('string');
    }
  });
});
