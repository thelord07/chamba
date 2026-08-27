import { inspectRepos, joinPath, loadConfig, WORKSPACE_DIR, WorktreeInspector } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_list_worktrees';

const DESCRIPTION =
  'List git worktrees with dirty/stale/ahead-behind flags and file overlap ' +
  '(NO LLM). Never merges. Prefer chamba_worktree_status for the full structured report.';

const CONFIG_FILE = `${WORKSPACE_DIR}/config.json`;

export function registerListWorktrees(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    { title: 'List worktrees', description: DESCRIPTION, inputSchema: {} },
    async () => {
      const { worktrees: cfg } = await loadConfig(services.fs, {
        globalPath: joinPath(services.homedir, CONFIG_FILE),
        projectPath: joinPath(services.cwd, CONFIG_FILE),
      });
      const inspector = new WorktreeInspector(services.process, services.clock);
      const inspections = await inspectRepos({
        inspector,
        fs: services.fs,
        cwd: services.cwd,
        baseBranch: cfg.baseBranch,
      });
      const worktrees = inspections.flatMap((i) => i.worktrees);
      const overlaps = inspections.flatMap((i) => i.overlaps);
      logger.info(
        { tool: TOOL_NAME, count: worktrees.length, overlaps: overlaps.length },
        'listed worktrees',
      );

      const lines: string[] = [];
      for (const w of worktrees) {
        const flags = [
          w.primary ? 'primary' : undefined,
          w.dirty ? 'dirty' : undefined,
          w.stale ? 'stale' : undefined,
        ].filter(Boolean);
        lines.push(
          `- ${w.path}${w.branch ? ` [${w.branch}]` : ''}${flags.length ? ` (${flags.join(', ')})` : ''}`,
        );
      }
      for (const o of overlaps) {
        lines.push(`overlap: ${o.a} ∩ ${o.b} → ${o.files.join(', ')}`);
      }
      const text =
        worktrees.length === 0 ? 'No worktrees found (or not a git repo).' : lines.join('\n');

      return {
        content: [{ type: 'text', text }],
        structuredContent: { worktrees, overlaps } as Record<string, unknown>,
      };
    },
  );
}
