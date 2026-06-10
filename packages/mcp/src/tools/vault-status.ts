import { listVaultNotes, ObsidianDetector } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { obsidianSearchRoots, type Services } from '../services.js';

const TOOL_NAME = 'chamba_vault_status';

const DESCRIPTION =
  'Diagnose the Obsidian vault connection: the resolved vault path, whether it was ' +
  'found, and the markdown notes chamba can actually see (the same set ' +
  '`chamba_load_context` searches). Use this to confirm the vault points at the ' +
  'vault root (the folder containing `.obsidian`), not at `.obsidian` itself.';

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
      const detection = await new ObsidianDetector(services.fs).detect({
        explicitPath: services.obsidianVaultPath,
        searchRoots: obsidianSearchRoots(services),
      });

      if (!detection.found || !detection.path) {
        const text =
          'No Obsidian vault found.\n' +
          `Set CHAMBA_OBSIDIAN_VAULT_PATH to your vault root (the folder containing ` +
          `.obsidian), or place the vault under a common location. Searched: ${obsidianSearchRoots(services).join(', ')}.`;
        logger.info({ tool: TOOL_NAME, found: false }, 'vault-status');
        return {
          content: [{ type: 'text', text }],
          structuredContent: { found: false } as Record<string, unknown>,
        };
      }

      const paths = await listVaultNotes(services.fs, detection.path);
      const names = paths.map((p) => p.slice(detection.path?.length ?? 0).replace(/^\/+/, ''));
      const source = services.obsidianVaultPath ? 'CHAMBA_OBSIDIAN_VAULT_PATH' : 'autodetected';

      logger.info({ tool: TOOL_NAME, vault: detection.path, notes: names.length }, 'vault-status');

      const shown = names.slice(0, MAX_LISTED);
      const more = names.length > MAX_LISTED ? `\n…and ${names.length - MAX_LISTED} more` : '';
      const text =
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
        } as Record<string, unknown>,
      };
    },
  );
}
