import { FilesystemMemoryStore } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { resolveActiveParcheVaultFull } from '../parche/active-vault.js';
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
      // O2: resolve full discriminated result — never fall through from bound-unsyncable
      const vaultResult = await resolveActiveParcheVaultFull(services);

      // O2: bound but unsyncable
      if (vaultResult.kind === 'bound-unsyncable') {
        if (!vaultResult.dirExists) {
          const dirMsg =
            vaultResult.reason === 'invalid-binding' || vaultResult.reason === 'error'
              ? `No se pudo guardar la memoria: ${vaultResult.hint}`
              : `No se pudo guardar la memoria: la carpeta del parche (${vaultResult.vaultDir}) no existe. ${vaultResult.hint}`;
          return {
            isError: true,
            content: [{ type: 'text' as const, text: dirMsg }],
          };
        }
        // Dir exists: write there but skip sync, add warning
        const store = new FilesystemMemoryStore(services.fs, services.clock, vaultResult.vaultDir, {
          dir: 'memory',
        });
        const memory = await store.remember({ key, content, tags });
        logger.info({ tool: TOOL_NAME, key, path: memory.path }, 'memory saved (bound-unsyncable)');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Saved memory '${key}' to ${memory.path}\n\n⚠ parche no sincronizable: ${vaultResult.hint}`,
            },
          ],
          structuredContent: { saved: true, path: memory.path } as Record<string, unknown>,
        };
      }

      const parcheVault = vaultResult.kind === 'ok' ? vaultResult.vault : null;

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

      // C5: push sync after writing (only with parche vault and autoSync enabled)
      let syncWarning: string | undefined;
      if (parcheVault?.autoSync.enabled) {
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
