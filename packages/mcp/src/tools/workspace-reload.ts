import {
  diffLines,
  joinPath,
  renderWorkspaceMarkdown,
  textsEqual,
  WORKSPACE_RELATIVE_PATH,
  WorkspaceScanner,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_workspace_reload';

const DESCRIPTION =
  'Re-scan the workspace and return a diff against the current ' +
  '`.chamba/workspace.md`. NEVER overwrites the file — the user may have hand-' +
  'edited it. The model decides whether to apply changes.';

/** Register `chamba_workspace_reload`: scan + diff, no writes. */
export function registerWorkspaceReload(
  server: McpServer,
  logger: Logger,
  services: Services,
): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Reload workspace',
      description: DESCRIPTION,
      inputSchema: {},
    },
    async () => {
      const wsPath = joinPath(services.cwd, WORKSPACE_RELATIVE_PATH);

      if (!(await services.fs.exists(wsPath))) {
        logger.info({ tool: TOOL_NAME, wsPath }, 'no workspace.md to reload');
        return {
          content: [
            {
              type: 'text',
              text: `No \`${WORKSPACE_RELATIVE_PATH}\` found at ${wsPath}. Run chamba_workspace_init first.`,
            },
          ],
        };
      }

      const current = await services.fs.readFile(wsPath);
      const scanner = new WorkspaceScanner(services.fs);
      const rescanned = renderWorkspaceMarkdown(await scanner.scan(services.cwd));

      if (textsEqual(current, rescanned)) {
        logger.info({ tool: TOOL_NAME, wsPath }, 'workspace.md up to date');
        return {
          content: [
            {
              type: 'text',
              text: `\`${WORKSPACE_RELATIVE_PATH}\` is up to date — no changes from a re-scan.`,
            },
          ],
        };
      }

      logger.info({ tool: TOOL_NAME, wsPath }, 'workspace.md differs from re-scan');
      return {
        content: [
          {
            type: 'text',
            text:
              `Re-scan differs from \`${WORKSPACE_RELATIVE_PATH}\` (NOT applied — your edits are kept). ` +
              `Diff (\`-\` current, \`+\` re-scan):\n\n\`\`\`diff\n${diffLines(current, rescanned)}\n\`\`\``,
          },
        ],
      };
    },
  );
}
