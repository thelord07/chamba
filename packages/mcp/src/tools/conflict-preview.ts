import {
  ConflictPreviewer,
  joinPath,
  loadConfig,
  WORKSPACE_DIR,
  WorktreeManager,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_conflict_preview';

const DESCRIPTION =
  'Dry-run merge conflicts with `git merge-tree` (NO LLM, NEVER merges): each ' +
  'worktree branch vs the base branch, plus pairwise among topic branches. ' +
  'Returns conflicted paths so you can sequence work instead of resolving later.';

const CONFIG_FILE = `${WORKSPACE_DIR}/config.json`;

export function registerConflictPreview(
  server: McpServer,
  logger: Logger,
  services: Services,
): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Conflict preview (merge-tree)',
      description: DESCRIPTION,
      inputSchema: {
        baseBranch: z.string().optional().describe('Base branch (default from config).'),
        branches: z
          .array(z.string())
          .optional()
          .describe('Topic branches to compare; default: non-primary worktree branches.'),
      },
    },
    async ({ baseBranch, branches }) => {
      const { worktrees: cfg } = await loadConfig(services.fs, {
        globalPath: joinPath(services.homedir, CONFIG_FILE),
        projectPath: joinPath(services.cwd, CONFIG_FILE),
      });
      const base = baseBranch ?? cfg.baseBranch;
      let topics = branches ?? [];
      if (topics.length === 0) {
        const listed = await new WorktreeManager(services.process).list(services.cwd);
        topics = listed.filter((w, i) => i > 0 && w.branch).map((w) => w.branch as string);
      }

      const report = await new ConflictPreviewer(services.process).previewBranches(
        services.cwd,
        topics,
        base,
      );
      const conflicted = [...report.vsBase, ...report.pairwise].filter((p) => p.files.length > 0);
      logger.info({ tool: TOOL_NAME, pairs: conflicted.length }, 'conflict-preview');

      const text = renderPreview(report, conflicted.length);
      return {
        content: [{ type: 'text', text }],
        structuredContent: { ...report, conflictedCount: conflicted.length },
      };
    },
  );
}

function renderPreview(
  report: Awaited<ReturnType<ConflictPreviewer['previewBranches']>>,
  conflictedCount: number,
): string {
  const lines = [`Conflict preview vs ${report.baseBranch} (merge-tree dry-run, never merged):`];
  const pairs = [...report.vsBase, ...report.pairwise];
  if (pairs.length === 0) {
    lines.push('No topic branches to compare.');
    return lines.join('\n');
  }
  for (const p of pairs) {
    if (p.mode === 'failed') {
      lines.push(`- ${p.left}…${p.right}: failed (${p.error ?? 'unknown'})`);
    } else if (p.files.length === 0) {
      lines.push(`- ${p.left}…${p.right}: clean`);
    } else {
      lines.push(`- ${p.left}…${p.right}: CONFLICT ${p.files.join(', ')}`);
    }
  }
  if (conflictedCount > 0) {
    lines.push('\nDo not merge automatically. Sequence those branches or ask the human.');
  }
  return lines.join('\n');
}
