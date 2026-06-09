import {
  joinPath,
  renderWorkspaceMarkdown,
  WORKSPACE_DIR,
  WORKSPACE_RELATIVE_PATH,
  WorkspaceScanner,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_workspace_init';

const DESCRIPTION =
  'Scan the workspace and generate `.chamba/workspace.md` (description, ' +
  'languages, framework, conventions, active projects, folder map). Respects ' +
  '.gitignore/.dockerignore and never reads node_modules or binaries. If the ' +
  'file already exists it is NOT overwritten — its current contents are ' +
  'returned so the model/user decides what to do.';

/** Register `chamba_workspace_init`: scan + write `.chamba/workspace.md`. */
export function registerWorkspaceInit(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Init workspace',
      description: DESCRIPTION,
      inputSchema: {
        root: z
          .string()
          .optional()
          .describe('Workspace root to scan. Defaults to the directory chamba runs in.'),
      },
    },
    async ({ root }) => {
      const workspaceRoot = root ?? services.cwd;
      const wsPath = joinPath(workspaceRoot, WORKSPACE_RELATIVE_PATH);

      if (await services.fs.exists(wsPath)) {
        const currentContents = await services.fs.readFile(wsPath);
        logger.info({ tool: TOOL_NAME, wsPath }, 'workspace.md already exists, not overwriting');
        return {
          content: [
            {
              type: 'text',
              text:
                `\`${WORKSPACE_RELATIVE_PATH}\` already exists at ${wsPath}; not overwriting.\n\n` +
                `Current contents:\n\n${currentContents}`,
            },
          ],
        };
      }

      const scanner = new WorkspaceScanner(services.fs);
      const workspace = await scanner.scan(workspaceRoot);
      const markdown = renderWorkspaceMarkdown(workspace);

      await services.fs.mkdir(joinPath(workspaceRoot, WORKSPACE_DIR));
      await services.fs.writeFile(wsPath, markdown);
      logger.info(
        { tool: TOOL_NAME, wsPath, projects: workspace.projects.length },
        'workspace.md created',
      );

      return {
        content: [
          {
            type: 'text',
            text: `Created \`${WORKSPACE_RELATIVE_PATH}\` at ${wsPath}.\n\n${markdown}`,
          },
        ],
      };
    },
  );
}
