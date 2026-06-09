import { generatePlanTemplate, WorkspaceScanner } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_generate_plan';

const DESCRIPTION =
  'Generate a structured plan TEMPLATE (not a finished plan) for a task: goal, ' +
  'acceptance criteria, subtasks with suggested workers, risks, and files likely ' +
  'touched. The editor model fills the placeholders, then calls chamba_review_plan. ' +
  'No LLM is used here.';

/** Register `chamba_generate_plan`: emit a plan skeleton seeded from the workspace. */
export function registerGeneratePlan(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Generate plan',
      description: DESCRIPTION,
      inputSchema: {
        task: z.string().describe('What the plan should accomplish.'),
        context: z.string().optional().describe('Context from chamba_load_context, if any.'),
      },
    },
    async ({ task, context }) => {
      const workspace = await new WorkspaceScanner(services.fs).scan(services.cwd);
      const template = generatePlanTemplate({ task, context, workspace });
      logger.info({ tool: TOOL_NAME }, 'plan template generated');
      return { content: [{ type: 'text', text: template }] };
    },
  );
}
