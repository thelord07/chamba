/**
 * vault-allow-secret-hook.test.ts — CHAMBA-021 D-Q2.
 *
 * `vault allow-secret` is the one command that marks a possible secret as a
 * false positive so it will be uploaded on the next sync. The PreToolUse hook
 * must `ask` for confirmation before it runs — same pattern as the DB-wipe
 * guard (CHAMBA-013) tested in db-guard-consistency.test.ts.
 *
 * Content check runs everywhere (cross-platform, no bash needed). The
 * execution check actually runs the hook under bash and is skipped on
 * win32 CI runners that may not have a POSIX shell available.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

function hookPath(): string {
  return fileURLToPath(new URL('../assets/hooks/PreToolUse-warn-destructive.sh', import.meta.url));
}

describe('PreToolUse hook — vault allow-secret guard (CHAMBA-021 D-Q2)', () => {
  const hookText = readFileSync(hookPath(), 'utf8');

  it('hook source contains an allow-secret pattern', () => {
    expect(hookText).toContain('allow-secret');
  });

  it('hook source asks (not blocks, not silently passes) for allow-secret', () => {
    const idx = hookText.indexOf('allow-secret');
    expect(idx).toBeGreaterThan(-1);
    // The `ask` call for this pattern must appear shortly after the case arm.
    const nearby = hookText.slice(idx, idx + 200);
    expect(nearby).toContain('ask ');
  });

  it.skipIf(process.platform === 'win32')(
    'running the hook with a `vault allow-secret` command returns permissionDecision: ask',
    () => {
      const input = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'npx @chamba/mcp vault allow-secret abc123def456 --path x.md' },
      });
      const output = execFileSync('bash', [hookPath()], { input, encoding: 'utf8' });
      const parsed = JSON.parse(output);
      expect(parsed.hookSpecificOutput.permissionDecision).toBe('ask');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'running the hook with an unrelated command returns {} (no decision)',
    () => {
      const input = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'npx @chamba/mcp vault status' },
      });
      const output = execFileSync('bash', [hookPath()], { input, encoding: 'utf8' });
      expect(JSON.parse(output)).toEqual({});
    },
  );
});
