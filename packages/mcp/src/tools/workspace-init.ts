import {
  joinPath,
  ObsidianDetector,
  renderWorkspaceMarkdown,
  VAULT_OVERVIEW_FILE,
  VaultInitializer,
  WORKSPACE_DIR,
  WORKSPACE_RELATIVE_PATH,
  WorkspaceScanner,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { obsidianSearchRoots, type Services } from '../services.js';

const TOOL_NAME = 'chamba_workspace_init';

const DESCRIPTION =
  'Scan the workspace and generate `.chamba/workspace.md` (description, ' +
  'languages, framework, conventions, active projects, folder map). Respects ' +
  '.gitignore/.dockerignore and never reads node_modules or binaries. If the ' +
  'file already exists it is NOT overwritten — its current contents are ' +
  'returned. When no Obsidian vault is available, it also bootstraps one at the ' +
  'workspace root and seeds a "Workspace overview" note (disable with createVault: false).';

/** Register `chamba_workspace_init`: scan + write `.chamba/workspace.md` + bootstrap a vault. */
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
        createVault: z
          .boolean()
          .optional()
          .describe('Bootstrap an Obsidian vault at the root when none is found (default true).'),
      },
    },
    async ({ root, createVault }) => {
      const workspaceRoot = root ?? services.cwd;
      const wsPath = joinPath(workspaceRoot, WORKSPACE_RELATIVE_PATH);

      const workspace = await new WorkspaceScanner(services.fs).scan(workspaceRoot);

      // workspace.md — write only when absent; never overwrite hand edits.
      const wsExisted = await services.fs.exists(wsPath);
      let markdown: string;
      if (wsExisted) {
        markdown = await services.fs.readFile(wsPath);
      } else {
        markdown = renderWorkspaceMarkdown(workspace);
        await services.fs.mkdir(joinPath(workspaceRoot, WORKSPACE_DIR));
        await services.fs.writeFile(wsPath, markdown);
      }
      const wsLine = wsExisted
        ? `\`${WORKSPACE_RELATIVE_PATH}\` already exists at ${wsPath}; not overwriting.`
        : `Created \`${WORKSPACE_RELATIVE_PATH}\` at ${wsPath}.`;

      // vault — bootstrap one at the workspace root if none is available.
      let vaultLine = 'Vault: skipped (createVault: false).';
      if (createVault !== false) {
        const detection = await new ObsidianDetector(services.fs).detect({
          explicitPath: services.obsidianVaultPath,
          searchRoots: obsidianSearchRoots(services),
        });
        if (detection.found) {
          vaultLine = `Vault: using the existing one at ${detection.path}; left it untouched.`;
        } else {
          const seeded = await new VaultInitializer(services.fs, services.clock).seed({
            vaultPath: workspaceRoot,
            workspace,
          });
          vaultLine =
            `Vault: none found — created one at the workspace root and seeded ` +
            `\`${VAULT_OVERVIEW_FILE}\`. Add \`.obsidian/\` to .gitignore if you don't want it committed.`;
          logger.info({ tool: TOOL_NAME, vault: seeded.vaultPath }, 'vault bootstrapped');
        }
      }

      logger.info(
        { tool: TOOL_NAME, wsPath, wsExisted, projects: workspace.projects.length },
        'workspace init',
      );

      return { content: [{ type: 'text', text: `${wsLine}\n${vaultLine}\n\n${markdown}` }] };
    },
  );
}
