import {
  ensureVaultGitignored,
  findGitRoot,
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
  'returned. When no Obsidian vault is available, it bootstraps a GLOBAL vault outside ' +
  'your repos (~/.chamba/vault) and seeds a "Workspace overview" note; a vault found ' +
  'inside a git repo gets its artifacts gitignored (disable with createVault: false).';

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

      // vault — bootstrap a GLOBAL vault outside any repo when none is available, and
      // gitignore any legacy vault that lives inside a git work tree (repo-safe).
      let vaultLine = 'Vault: skipped (createVault: false).';
      if (createVault !== false) {
        const detection = await new ObsidianDetector(services.fs).detect({
          explicitPath: services.obsidianVaultPath,
          searchRoots: obsidianSearchRoots(services),
        });
        if (detection.found && detection.path) {
          const gitRoot = await findGitRoot(services.fs, detection.path);
          if (gitRoot) {
            const added = await ensureVaultGitignored(services.fs, gitRoot);
            vaultLine =
              `Vault: using ${detection.path} — it's inside a git repo (${gitRoot}), so ` +
              (added.length > 0
                ? `I gitignored its artifacts (${added.join(', ')}) so notes/memory aren't committed. `
                : 'its artifacts are already gitignored. ') +
              'Consider moving it outside the repo (e.g. ~/.chamba/vault).';
          } else {
            vaultLine = `Vault: using the existing one at ${detection.path}; left it untouched.`;
          }
        } else {
          const globalVault = joinPath(services.homedir, WORKSPACE_DIR, 'vault');
          const seeded = await new VaultInitializer(services.fs, services.clock).seed({
            vaultPath: globalVault,
            workspace,
          });
          vaultLine =
            `Vault: none found — created a global vault at ${seeded.vaultPath} (outside your ` +
            `repos) and seeded \`${VAULT_OVERVIEW_FILE}\`. It's autodetected; set ` +
            `CHAMBA_OBSIDIAN_VAULT_PATH to point elsewhere.`;
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
