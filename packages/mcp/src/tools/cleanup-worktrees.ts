import {
  detectGitRepos,
  joinPath,
  loadConfig,
  MultiRepoWorktreeManager,
  planWorktrees,
  WORKSPACE_DIR,
  type WorktreeConfig,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_cleanup_worktrees';

const DESCRIPTION =
  "Remove a ticket's git worktrees across its repos. Removes only the worktree " +
  'directories (no --force), KEEPS every branch for you to review and merge by ' +
  'hand. Returns the suggested `git merge --no-ff` command per repo.';

const CONFIG_FILE = `${WORKSPACE_DIR}/config.json`;

async function resolveRepos(
  config: WorktreeConfig,
  services: Services,
  explicit?: string[],
): Promise<string[]> {
  if (explicit && explicit.length > 0) return explicit;
  if (config.repos && config.repos.length > 0) return config.repos;
  return detectGitRepos(services.fs, services.cwd);
}

export function registerCleanupWorktrees(
  server: McpServer,
  logger: Logger,
  services: Services,
): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Cleanup worktrees (multi-repo)',
      description: DESCRIPTION,
      inputSchema: {
        ticket: z.string().describe('Ticket id whose worktrees to remove.'),
        repos: z.array(z.string()).optional().describe('Repos to clean; defaults like create.'),
      },
    },
    async ({ ticket, repos }) => {
      const globalPath = joinPath(services.homedir, CONFIG_FILE);
      const projectPath = joinPath(services.cwd, CONFIG_FILE);
      const { worktrees } = await loadConfig(services.fs, { globalPath, projectPath });

      const repoList = await resolveRepos(worktrees, services, repos);
      const items = planWorktrees({
        workspaceRoot: services.cwd,
        ticket,
        repos: repoList,
        config: worktrees,
      });
      const results = await new MultiRepoWorktreeManager(services.process, services.fs).cleanup(
        items,
      );

      logger.info({ tool: TOOL_NAME, ticket, repos: results.length }, 'cleanup-worktrees');

      const removed = results.filter((r) => r.removed);
      const lines = results.map(
        (r) => `- ${r.repo}: ${r.removed ? 'removed' : 'not found'} — merge: ${r.mergeSuggestion}`,
      );
      const text =
        `Cleaned ${removed.length}/${results.length} worktree(s) for ${ticket}. Branches kept.\n` +
        `${lines.join('\n')}`;

      return {
        content: [{ type: 'text', text }],
        structuredContent: { ticket, worktrees: results } as Record<string, unknown>,
      };
    },
  );
}
