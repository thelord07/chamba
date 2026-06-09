import { joinPath, WORKSPACE_RELATIVE_PATH } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_workspace_show';

const DESCRIPTION =
  'Show the current workspace map. Reads `.chamba/workspace.md` from the ' +
  'workspace root and returns its contents. If no workspace file exists yet, ' +
  'says so — the model can then run chamba_workspace_init to create one.';

/** Register `chamba_workspace_show`: pure read of `.chamba/workspace.md`. */
export function registerWorkspaceShow(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Show workspace',
      description: DESCRIPTION,
      inputSchema: {},
    },
    async () => {
      const path = joinPath(services.cwd, WORKSPACE_RELATIVE_PATH);
      try {
        const contents = await services.fs.readFile(path);
        logger.info({ tool: TOOL_NAME, path }, 'workspace.md read');
        return { content: [{ type: 'text', text: contents }] };
      } catch {
        logger.info({ tool: TOOL_NAME, path }, 'no workspace.md found');
        return {
          content: [
            {
              type: 'text',
              text: `No \`${WORKSPACE_RELATIVE_PATH}\` found at ${path}. Run chamba_workspace_init to create one.`,
            },
          ],
        };
      }
    },
  );
}
