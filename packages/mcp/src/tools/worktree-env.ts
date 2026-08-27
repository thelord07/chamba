import {
  assignWorktreePorts,
  joinPath,
  loadConfig,
  planWorktrees,
  WORKSPACE_DIR,
  WorktreeManager,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_worktree_env';

const DESCRIPTION =
  'Assign a unique localhost PORT per worktree and upsert it in `.env.local` ' +
  '(NO LLM). Skips occupied ports; never kills a process. No-op unless ' +
  '`worktrees.ports.enabled` is true. Does not copy node_modules.';

const CONFIG_FILE = `${WORKSPACE_DIR}/config.json`;

export function registerWorktreeEnv(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Worktree env (ports)',
      description: DESCRIPTION,
      inputSchema: {
        ticket: z.string().optional().describe("Assign ports for this ticket's planned worktrees."),
        worktreePath: z
          .string()
          .optional()
          .describe('Assign a port for a single worktree directory.'),
        repos: z.array(z.string()).optional(),
      },
    },
    async ({ ticket, worktreePath, repos }) => {
      const { worktrees: cfg } = await loadConfig(services.fs, {
        globalPath: joinPath(services.homedir, CONFIG_FILE),
        projectPath: joinPath(services.cwd, CONFIG_FILE),
      });
      if (!cfg.ports.enabled) {
        const text =
          'worktrees.ports.enabled is false. Set it in .chamba/config.json to write .env.local PORT values.';
        return {
          content: [{ type: 'text', text }],
          structuredContent: { assigned: [], enabled: false },
        };
      }
      if (!services.net) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'No NetPort available to probe ports.' }],
        };
      }

      let paths: string[] = [];
      if (worktreePath) {
        paths = [worktreePath];
      } else if (ticket) {
        const repoList = repos && repos.length > 0 ? repos : (cfg.repos ?? []);
        const items = planWorktrees({
          workspaceRoot: services.cwd,
          ticket,
          repos: repoList.length > 0 ? repoList : ['repo'],
          config: cfg,
        });
        paths = items.map((i) => i.worktreePath);
      } else {
        const listed = await new WorktreeManager(services.process).list(services.cwd);
        paths = listed.filter((_, i) => i > 0).map((w) => w.path);
      }

      const assigned = await assignWorktreePorts({
        net: services.net,
        fs: services.fs,
        worktreePaths: paths,
        ports: cfg.ports,
      });
      logger.info({ tool: TOOL_NAME, count: assigned.length }, 'worktree-env');

      const text =
        assigned.length === 0
          ? 'No worktrees to assign a PORT to.'
          : assigned
              .map((a) => `- ${a.path}: ${a.envKey}=${a.port}${a.reused ? ' (reused)' : ''}`)
              .join('\n');

      return {
        content: [{ type: 'text', text }],
        structuredContent: { enabled: true, assigned },
      };
    },
  );
}
