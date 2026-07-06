import { ObsidianDetector, VAULT_PLANS_DIR, VaultWriter } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { readGitRemote } from '../git-remote.js';
import { obsidianSearchRoots, type Services } from '../services.js';

const TOOL_NAME = 'chamba_save_plan';

const NO_VAULT_ERROR =
  'No Obsidian vault configured. Set CHAMBA_OBSIDIAN_VAULT_PATH or run chamba_workspace_init to bootstrap one';

const DESCRIPTION =
  'Save a plan to the Obsidian vault under `plans/[<owner-repo>/]<date>-<slug>.md` with valid ' +
  'YAML frontmatter. Use this when a plan is finalized so every plan is persisted alongside ' +
  'the run summaries (which go under `proyectos/`). Grouped per project (git remote) and ' +
  'indexed for cheap recall. Fails clearly if no vault is configured.';

/** Register `chamba_save_plan`: write a plan to the vault's `plans/` folder. */
export function registerSavePlan(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Save plan',
      description: DESCRIPTION,
      inputSchema: {
        title: z.string().describe('Plan title — usually the ticket id or task name.'),
        content: z.string().describe('The plan markdown (goal, acceptance criteria, subtasks…).'),
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
        subdir: VAULT_PLANS_DIR,
        tags: ['chamba', 'plan'],
        projectRemoteUrl: await readGitRemote(services.process, services.cwd),
      });
      logger.info({ tool: TOOL_NAME, notePath }, 'plan saved to vault');

      return { content: [{ type: 'text', text: `Saved plan to ${notePath}` }] };
    },
  );
}
