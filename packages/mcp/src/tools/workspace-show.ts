import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';

const TOOL_NAME = 'chamba_workspace_show';

const DESCRIPTION =
  'Show the current workspace map. Reads `.chamba/workspace.md` from the ' +
  'directory where the editor launched chamba (cwd) and returns its contents. ' +
  'If no workspace file exists yet, says so — the model can then suggest ' +
  'running workspace init (available from Phase 2).';

/**
 * Register the `chamba_workspace_show` tool on the given server.
 *
 * This is the smallest tool that does something real: it reads a file from the
 * user's project and returns it. No LLM, no side effects — pure read.
 */
export function registerWorkspaceShow(server: McpServer, logger: Logger): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Show workspace',
      description: DESCRIPTION,
      // No inputs: the tool always reads `.chamba/workspace.md` from the cwd.
      inputSchema: {},
    },
    async () => {
      const path = join(process.cwd(), '.chamba', 'workspace.md');
      try {
        const contents = await readFile(path, 'utf8');
        logger.info({ tool: TOOL_NAME, path }, 'workspace.md read');
        return { content: [{ type: 'text', text: contents }] };
      } catch {
        logger.info({ tool: TOOL_NAME, path }, 'no workspace.md found');
        return {
          content: [
            {
              type: 'text',
              text: `No \`.chamba/workspace.md\` found at ${path}. Run a workspace init tool to create one.`,
            },
          ],
        };
      }
    },
  );
}
