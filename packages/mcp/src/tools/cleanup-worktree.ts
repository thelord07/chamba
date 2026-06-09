import { WorktreeError, WorktreeManager } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_cleanup_worktree';

const DESCRIPTION =
  'Remove a worktree directory while KEEPING its branch. Never deletes the branch ' +
  'and never merges — the branch stays for you to review and merge by hand. Runs ' +
  '`git worktree remove` without --force, so a dirty worktree fails loudly.';

export function registerCleanupWorktree(
  server: McpServer,
  logger: Logger,
  services: Services,
): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Cleanup worktree',
      description: DESCRIPTION,
      inputSchema: {
        branch: z.string().describe('Branch whose worktree directory should be removed.'),
      },
    },
    async ({ branch }) => {
      try {
        const result = await new WorktreeManager(services.process).cleanup(services.cwd, branch);
        logger.info({ tool: TOOL_NAME, branch }, 'worktree removed, branch kept');
        return {
          content: [
            {
              type: 'text',
              text: `Removed worktree for ${branch}. Branch kept. To merge: ${result.mergeSuggestion}`,
            },
          ],
          structuredContent: { ...result } as Record<string, unknown>,
        };
      } catch (err) {
        const message = err instanceof WorktreeError ? err.message : String(err);
        logger.info({ tool: TOOL_NAME, branch, err: message }, 'worktree cleanup failed');
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    },
  );
}
