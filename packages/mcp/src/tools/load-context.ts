import { ContextBuilder, ObsidianDetector, WorkspaceScanner } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { obsidianSearchRoots, type Services } from '../services.js';

const TOOL_NAME = 'chamba_load_context';

const DESCRIPTION =
  'Load context for a task: a summary of the workspace plus, when an Obsidian ' +
  'vault is available, the notes most relevant to the task (keyword search). ' +
  'Returns a markdown block the model can reason over before planning.';

/** Register `chamba_load_context`: workspace summary + relevant vault notes. */
export function registerLoadContext(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Load context',
      description: DESCRIPTION,
      inputSchema: {
        task: z.string().describe('The task you are about to work on.'),
        includeObsidian: z
          .boolean()
          .optional()
          .describe('Search the Obsidian vault for relevant notes (default true).'),
        includeRules: z
          .boolean()
          .optional()
          .describe("Include each repo's coding rules across editors (default true)."),
      },
    },
    async ({ task, includeObsidian, includeRules }) => {
      const workspace = await new WorkspaceScanner(services.fs).scan(services.cwd);

      let vaultPath: string | undefined;
      if (includeObsidian !== false) {
        const detection = await new ObsidianDetector(services.fs).detect({
          explicitPath: services.obsidianVaultPath,
          searchRoots: obsidianSearchRoots(services),
        });
        if (detection.found) vaultPath = detection.path;
      }

      const built = await new ContextBuilder(services.fs).build({
        workspace,
        task,
        vaultPath,
        includeRules,
      });
      logger.info(
        { tool: TOOL_NAME, vault: vaultPath ?? null, notes: built.relevantNotes.length },
        'context built',
      );

      return { content: [{ type: 'text', text: built.context }] };
    },
  );
}
