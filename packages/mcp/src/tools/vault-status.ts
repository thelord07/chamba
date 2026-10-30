import {
  findWorkspaceRoot,
  listVaultNotes,
  ObsidianDetector,
  parcheFilePath,
  readParcheBinding,
  resolveParcheBinding,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { obsidianSearchRoots, type Services } from '../services.js';

const TOOL_NAME = 'chamba_vault_status';

const DESCRIPTION =
  'Diagnose the Obsidian vault connection: workspace root and source (env/cwd), ' +
  'the active parche binding (workspace, global, or none), the resolved vault path, ' +
  'whether it was found, and the markdown notes chamba can actually see. ' +
  'Use this to confirm the vault points at the vault root (the folder containing `.obsidian`), not at `.obsidian` itself.';

const MAX_LISTED = 50;

export function registerVaultStatus(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Vault status',
      description: DESCRIPTION,
      inputSchema: {},
    },
    async () => {
      // O3/R3: resolve workspace root and binding
      const wsRoot =
        services.workspaceRoot ??
        (await findWorkspaceRoot(services.fs, services.cwd, services.homedir));
      const wsRootSource: 'env' | 'cwd' | null = services.workspaceRoot
        ? 'env'
        : wsRoot
          ? 'cwd'
          : null;

      const binding = await resolveParcheBinding(
        { fs: services.fs },
        { cwd: services.cwd, homedir: services.homedir, workspaceRoot: wsRoot ?? undefined },
      );

      // Bug 5: detect invalid workspace binding and show as warn
      let invalidBindingWarning: string | undefined;
      if (!binding && wsRoot) {
        const wsBindingPath = parcheFilePath(wsRoot);
        const wsRaw = await readParcheBinding(services.fs, wsBindingPath, {
          scope: 'workspace',
          baseDir: wsRoot,
        });
        if (!wsRaw.ok && !wsRaw.missing) {
          invalidBindingWarning = `⚠ binding inválido en ${wsBindingPath}: ${wsRaw.error}`;
        }
      }
      if (!binding && !invalidBindingWarning) {
        const globalPath = parcheFilePath(services.homedir);
        const globalRaw = await readParcheBinding(services.fs, globalPath, {
          scope: 'global',
          baseDir: services.homedir,
        });
        if (!globalRaw.ok && !globalRaw.missing) {
          invalidBindingWarning = `⚠ binding inválido en ${globalPath}: ${globalRaw.error}`;
        }
      }

      const lines: string[] = [];
      // Workspace section
      if (wsRoot) {
        lines.push(`Workspace: ${wsRoot} (${wsRootSource})`);
      } else {
        lines.push('Workspace: none detected');
      }
      // Binding section
      if (binding) {
        lines.push(
          `Parche binding: ${binding.scope} — slug="${binding.slug}", server=${binding.server}, dir=${binding.vaultDir}`,
        );
      } else if (invalidBindingWarning) {
        lines.push(invalidBindingWarning);
      } else {
        lines.push('Parche binding: none');
      }
      lines.push('');

      const detection = await new ObsidianDetector(services.fs).detect({
        explicitPath: services.obsidianVaultPath,
        searchRoots: obsidianSearchRoots(services),
      });

      if (!detection.found || !detection.path) {
        const text =
          lines.join('\n') +
          'No Obsidian vault found.\n' +
          `Set CHAMBA_OBSIDIAN_VAULT_PATH to your vault root (the folder containing ` +
          `.obsidian), or place the vault under a common location. Searched: ${obsidianSearchRoots(services).join(', ')}.`;
        logger.info({ tool: TOOL_NAME, found: false }, 'vault-status');
        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            found: false,
            workspaceRoot: wsRoot,
            workspaceRootSource: wsRootSource,
            binding: binding
              ? { scope: binding.scope, slug: binding.slug, vaultDir: binding.vaultDir }
              : null,
          } as Record<string, unknown>,
        };
      }

      const paths = await listVaultNotes(services.fs, detection.path);
      const names = paths.map((p) => p.slice(detection.path?.length ?? 0).replace(/^\/+/, ''));
      const source = services.obsidianVaultPath ? 'CHAMBA_OBSIDIAN_VAULT_PATH' : 'autodetected';

      logger.info({ tool: TOOL_NAME, vault: detection.path, notes: names.length }, 'vault-status');

      const shown = names.slice(0, MAX_LISTED);
      const more = names.length > MAX_LISTED ? `\n…and ${names.length - MAX_LISTED} more` : '';
      const text =
        lines.join('\n') +
        `Vault: ${detection.path} (${source})\n` +
        `Notes chamba can see: ${names.length}\n\n${shown.map((n) => `- ${n}`).join('\n')}${more}` +
        (names.length === 0
          ? '\n\n⚠️ No notes found. If your path ends in `.obsidian`, point it at the parent folder instead.'
          : '');

      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          found: true,
          vaultPath: detection.path,
          source,
          noteCount: names.length,
          notes: shown,
          workspaceRoot: wsRoot,
          workspaceRootSource: wsRootSource,
          binding: binding
            ? { scope: binding.scope, slug: binding.slug, vaultDir: binding.vaultDir }
            : null,
        } as Record<string, unknown>,
      };
    },
  );
}
