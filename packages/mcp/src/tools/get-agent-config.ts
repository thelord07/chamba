import {
  AGENT_ROLES,
  type AgentRole,
  buildHint,
  getModel,
  joinPath,
  loadConfig,
  resolveRole,
  WORKSPACE_DIR,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_get_agent_config';

const DESCRIPTION =
  'Return the configured model + effort hint for a given agent role ' +
  '(orchestrator, planner, reviewer, implementer, tester, summarizer, researcher). ' +
  "chamba does not call any model — this is guidance the editor's own model can use " +
  'to decide how to delegate. Reads ~/.chamba/config.json and ./.chamba/config.json ' +
  '(project overrides global); falls back to built-in defaults.';

const CONFIG_FILE = `${WORKSPACE_DIR}/config.json`;

export function registerGetAgentConfig(
  server: McpServer,
  logger: Logger,
  services: Services,
): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Get agent config',
      description: DESCRIPTION,
      inputSchema: {
        role: z
          .enum([...AGENT_ROLES] as [AgentRole, ...AgentRole[]])
          .describe('The agent role to get a model + effort hint for.'),
      },
    },
    async ({ role }) => {
      const globalPath = joinPath(services.homedir, CONFIG_FILE);
      const projectPath = joinPath(services.cwd, CONFIG_FILE);
      const { config, sources } = await loadConfig(services.fs, { globalPath, projectPath });

      const agent = resolveRole(config, role);
      const model = getModel(agent.model);
      const hint = buildHint(role, agent);
      const invalid = sources.find((s) => s.status === 'invalid');
      const warning = invalid
        ? `Ignored invalid config at ${invalid.path}: ${invalid.error}. Using defaults.`
        : undefined;

      logger.info(
        { tool: TOOL_NAME, role, model: agent.model, effort: agent.effort },
        'get-agent-config',
      );

      const structured = {
        role,
        model: agent.model,
        effort: agent.effort,
        reasoning_priority: agent.reasoning_priority,
        provider: model?.provider ?? 'unknown',
        hint,
        ...(warning ? { warning } : {}),
      };

      return {
        content: [{ type: 'text', text: warning ? `${hint}\n\n⚠️ ${warning}` : hint }],
        structuredContent: structured as Record<string, unknown>,
      };
    },
  );
}
