import { ObsidianDetector, VaultWriter } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { obsidianSearchRoots, type Services } from '../services.js';

const TOOL_NAME = 'chamba_summarize_to_vault';

const NO_VAULT_ERROR =
  'No Obsidian vault configured. Set CHAMBA_OBSIDIAN_VAULT_PATH or use the obsidian-mcp server';

const DESCRIPTION =
  'Write a structured summary note to the Obsidian vault under ' +
  '`proyectos/<date>-<slug>.md` with valid YAML frontmatter. Fails clearly if ' +
  'no vault is configured.';

/** Register `chamba_summarize_to_vault`: write a note to the vault. */
export function registerSummarizeToVault(
  server: McpServer,
  logger: Logger,
  services: Services,
): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Summarize to vault',
      description: DESCRIPTION,
      inputSchema: {
        title: z.string().describe('Note title.'),
        content: z.string().describe('Markdown body (summary, plan, decisions, next steps).'),
        projectSlug: z.string().optional().describe('Optional slug for the filename.'),
      },
    },
    async ({ title, content, projectSlug }) => {
      const detection = await new ObsidianDetector(services.fs).detect({
        explicitPath: services.obsidianVaultPath,
        searchRoots: obsidianSearchRoots(services),
      });

      if (!detection.found || !detection.path) {
        logger.info({ tool: TOOL_NAME }, 'no vault configured');
        return { isError: true, content: [{ type: 'text', text: NO_VAULT_ERROR }] };
      }

      const writer = new VaultWriter(services.fs, services.clock);
      const { notePath } = await writer.write({
        vaultPath: detection.path,
        title,
        content,
        projectSlug,
      });
      logger.info({ tool: TOOL_NAME, notePath }, 'note written to vault');

      return { content: [{ type: 'text', text: `Wrote note to ${notePath}` }] };
    },
  );
}
