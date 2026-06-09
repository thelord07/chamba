import { GitDetector, WorktreeError, WorktreeManager } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_create_worktree';

const NOT_GIT = 'Not a git repo, worktree skipped. Worker should use main cwd.';

const DESCRIPTION =
  'Create an isolated git worktree for a task/worker under ' +
  '`.chamba/worktrees/<task>/<worker>/` on branch `chamba/<date>-<task>/<worker>`. ' +
  'If the directory is not a git repo, returns an error and the worker should use ' +
  'the main cwd instead.';

export function registerCreateWorktree(
  server: McpServer,
  logger: Logger,
  services: Services,
): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Create worktree',
      description: DESCRIPTION,
      inputSchema: {
        taskSlug: z.string().describe('Short task identifier (slugified for git).'),
        workerId: z.string().describe('Worker identifier, e.g. "implementer".'),
        baseBranch: z.string().optional().describe('Branch to base the worktree on.'),
      },
    },
    async ({ taskSlug, workerId, baseBranch }) => {
      const isGit = await new GitDetector(services.process).isGitRepo(services.cwd);
      if (!isGit) {
        logger.info({ tool: TOOL_NAME }, 'not a git repo');
        return { isError: true, content: [{ type: 'text', text: NOT_GIT }] };
      }

      try {
        const handle = await new WorktreeManager(services.process).create({
          root: services.cwd,
          taskSlug,
          workerId,
          date: services.clock.today(),
          baseBranch,
        });
        logger.info({ tool: TOOL_NAME, branch: handle.branch }, 'worktree created');
        return {
          content: [
            { type: 'text', text: `Created worktree at ${handle.path} on branch ${handle.branch}` },
          ],
          structuredContent: { ...handle } as Record<string, unknown>,
        };
      } catch (err) {
        const message = err instanceof WorktreeError ? err.message : String(err);
        logger.info({ tool: TOOL_NAME, err: message }, 'worktree create failed');
        return { isError: true, content: [{ type: 'text', text: message }] };
      }
    },
  );
}
