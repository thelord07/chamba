import { FilesystemMemoryStore } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { resolveActiveParcheVault } from '../parche/active-vault.js';
import { maybeAutoSync } from '../parche/autosync.js';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_remember';

const DESCRIPTION =
  'Persist a piece of knowledge across sessions as an editable markdown file. ' +
  'With an active parche vault: writes to `<vault>/memory/<key>.md` and syncs. ' +
  'Without parche: writes to `.chamba/memory/<key>.md` in the cwd. ' +
  'Re-remembering an existing key appends a timestamped section instead of overwriting.';

export function registerRemember(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Remember',
      description: DESCRIPTION,
      inputSchema: {
        key: z.string().describe('Short identifier, e.g. "auth-decisions".'),
        content: z.string().describe('What to remember (markdown).'),
        tags: z.array(z.string()).optional().describe('Optional tags for search.'),
      },
    },
    async ({ key, content, tags }) => {
      // C5 gate decision 4a: with a parche vault, write to <vault>/memory/
      const parcheVault = await resolveActiveParcheVault(services);

      let store: FilesystemMemoryStore;
      if (parcheVault) {
        // Use the vault dir as root, with 'memory' as the subdirectory
        store = new FilesystemMemoryStore(services.fs, services.clock, parcheVault.vaultDir, {
          dir: 'memory',
        });
      } else {
        store = new FilesystemMemoryStore(services.fs, services.clock, services.cwd);
      }

      const memory = await store.remember({ key, content, tags });
      logger.info({ tool: TOOL_NAME, key, path: memory.path }, 'memory saved');

      // C5: push sync after writing (only with parche vault)
      let syncWarning: string | undefined;
      if (parcheVault) {
        const syncResult = await maybeAutoSync(services, logger, parcheVault, 'push');
        syncWarning = syncResult.warning;
      }

      const text = syncWarning
        ? `Saved memory '${key}' to ${memory.path}\n\n⚠ ${syncWarning}`
        : `Saved memory '${key}' to ${memory.path}`;

      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: { saved: true, path: memory.path } as Record<string, unknown>,
      };
    },
  );
}
