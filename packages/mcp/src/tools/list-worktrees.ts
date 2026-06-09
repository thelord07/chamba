import { WorktreeManager } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_list_worktrees';

const DESCRIPTION = 'List the git worktrees in the current repo (path, HEAD, branch).';

export function registerListWorktrees(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    { title: 'List worktrees', description: DESCRIPTION, inputSchema: {} },
    async () => {
      const worktrees = await new WorktreeManager(services.process).list(services.cwd);
      logger.info({ tool: TOOL_NAME, count: worktrees.length }, 'listed worktrees');

      const text =
        worktrees.length === 0
          ? 'No worktrees found (or not a git repo).'
          : worktrees.map((w) => `- ${w.path}${w.branch ? ` [${w.branch}]` : ''}`).join('\n');

      return {
        content: [{ type: 'text', text }],
        structuredContent: { worktrees } as Record<string, unknown>,
      };
    },
  );
}
