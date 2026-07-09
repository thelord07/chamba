import { computeConcurrencyBudget, joinPath, loadConfig, WORKSPACE_DIR } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_resource_budget';

const DESCRIPTION =
  'Compute a SAFE parallelism budget from the machine (NO LLM): reads live RAM, CPU ' +
  'cores and load, and returns how many worktrees/subagents to run in parallel before ' +
  'a multi-repo fan-out exhausts memory. Call it BEFORE launching per-repo workers in ' +
  '/ticket; if `recommended` < the repos you have, run them in waves of `recommended`. ' +
  'Respects `worktrees.maxParallel` / `worktrees.perWorkerMemMB` in .chamba/config.json.';

const CONFIG_FILE = `${WORKSPACE_DIR}/config.json`;

export function registerResourceBudget(
  server: McpServer,
  logger: Logger,
  services: Services,
): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Resource budget (safe parallelism)',
      description: DESCRIPTION,
      inputSchema: {
        requested: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('How many workers you want to run (e.g. number of repos touched).'),
        perWorkerMemMB: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Override the estimated RAM per worker, in MB (default 2048).'),
      },
    },
    async ({ requested, perWorkerMemMB }) => {
      const globalPath = joinPath(services.homedir, CONFIG_FILE);
      const projectPath = joinPath(services.cwd, CONFIG_FILE);
      const { worktrees } = await loadConfig(services.fs, { globalPath, projectPath });

      const budget = computeConcurrencyBudget({
        resources: services.system.resources(),
        requested,
        // Explicit arg wins over config, which wins over the built-in default.
        perWorkerMemMB: perWorkerMemMB ?? worktrees.perWorkerMemMB ?? undefined,
        cap: worktrees.maxParallel ?? undefined,
      });

      logger.info(
        { tool: TOOL_NAME, recommended: budget.recommended, limitedBy: budget.limitedBy },
        'resource-budget',
      );

      return {
        content: [{ type: 'text', text: budget.reason }],
        structuredContent: {
          recommended: budget.recommended,
          limitedBy: budget.limitedBy,
          memBudget: budget.memBudget,
          cpuBudget: budget.cpuBudget,
          totalMemGB: budget.totalMemGB,
          freeMemGB: budget.freeMemGB,
          cpus: budget.cpus,
          reason: budget.reason,
        } as Record<string, unknown>,
      };
    },
  );
}
