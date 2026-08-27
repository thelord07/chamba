import { inspectRepos, joinPath, loadConfig, WORKSPACE_DIR, WorktreeInspector } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_worktree_status';

const DESCRIPTION =
  'Inspect git worktrees (NO LLM): dirty, ahead/behind base, unpushed, stale, ' +
  'changed files, and file overlap across worktrees. Never merges. Call this ' +
  'before fanning out workers; if files overlap, run those worktrees sequentially.';

const CONFIG_FILE = `${WORKSPACE_DIR}/config.json`;

export function registerWorktreeStatus(
  server: McpServer,
  logger: Logger,
  services: Services,
): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Worktree status (overlap)',
      description: DESCRIPTION,
      inputSchema: {
        repos: z
          .array(z.string())
          .optional()
          .describe('Repo names or paths; default autodetect or the current git repo.'),
        baseBranch: z
          .string()
          .optional()
          .describe('Branch to compare against (default from config).'),
      },
    },
    async ({ repos, baseBranch }) => {
      const { worktrees: cfg } = await loadConfig(services.fs, {
        globalPath: joinPath(services.homedir, CONFIG_FILE),
        projectPath: joinPath(services.cwd, CONFIG_FILE),
      });
      const base = baseBranch ?? cfg.baseBranch;
      const inspector = new WorktreeInspector(services.process, services.clock);
      const inspections = await inspectRepos({
        inspector,
        fs: services.fs,
        cwd: services.cwd,
        repos,
        baseBranch: base,
      });
      const overlapCount = inspections.reduce((n, i) => n + i.overlaps.length, 0);
      const ok = !(cfg.overlap.failOnOverlap && overlapCount > 0);

      logger.info({ tool: TOOL_NAME, overlapCount, ok }, 'worktree-status');

      const text = renderStatus(inspections, overlapCount, cfg.overlap.failOnOverlap, ok);
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          ok,
          overlapCount,
          failOnOverlap: cfg.overlap.failOnOverlap,
          inspections,
        },
      };
    },
  );
}

function renderStatus(
  inspections: Awaited<ReturnType<typeof inspectRepos>>,
  overlapCount: number,
  failOnOverlap: boolean,
  ok: boolean,
): string {
  const lines: string[] = [];
  for (const ins of inspections) {
    if (ins.worktrees.length === 0) {
      lines.push(`${ins.repoRoot}: no worktrees (or not a git repo).`);
      continue;
    }
    lines.push(`${ins.repoRoot} (base ${ins.baseBranch}):`);
    for (const w of ins.worktrees) {
      const flags: string[] = [];
      if (w.primary) flags.push('primary');
      if (w.dirty) flags.push('dirty');
      if (w.stale) flags.push('stale');
      if (w.ahead != null) flags.push(`ahead ${w.ahead}`);
      if (w.behind != null && w.behind > 0) flags.push(`behind ${w.behind}`);
      if (w.unpushed != null && w.unpushed > 0) flags.push(`unpushed ${w.unpushed}`);
      const files =
        w.changedFiles.length > 0 ? ` files: ${w.changedFiles.slice(0, 8).join(', ')}` : '';
      lines.push(
        `  - ${w.path}${w.branch ? ` [${w.branch}]` : ''} ${flags.join(' ')}${files}`.trimEnd(),
      );
    }
    for (const o of ins.overlaps) {
      lines.push(`  overlap: ${o.a} ∩ ${o.b} → ${o.files.join(', ')}`);
    }
  }
  if (overlapCount > 0) {
    lines.push(
      failOnOverlap && !ok
        ? `\nFAIL: ${overlapCount} overlapping pair(s). Run those worktrees sequentially (worktrees.overlap.failOnOverlap).`
        : `\n${overlapCount} overlapping pair(s) — run those worktrees sequentially. Never merge automatically.`,
    );
  }
  return lines.join('\n') || 'No worktrees found.';
}
