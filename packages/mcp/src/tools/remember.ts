import {
  buildProvenance,
  detectInstructionLike,
  FilesystemMemoryStore,
  mergeInstructionLike,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { resolveActiveParcheVaultFull } from '../parche/active-vault.js';
import { maybeAutoSync } from '../parche/autosync.js';
import { resolveAuthor } from '../parche/provenance.js';
import type { Services } from '../services.js';
import { secretWriteGate } from '../write-gate.js';

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
      // D-Q1 (CHAMBA-021 §9): reject a possible secret BEFORE anything is written.
      const gate = await secretWriteGate(services.hash, [
        { field: 'key', value: key },
        { field: 'content', value: content },
        { field: 'tags', value: tags },
      ]);
      if (gate.blocked) {
        return { isError: true, content: [{ type: 'text' as const, text: gate.text as string }] };
      }

      // O2: resolve full discriminated result — never fall through from bound-unsyncable
      const vaultResult = await resolveActiveParcheVaultFull(services);
      const author = await resolveAuthor(services, vaultResult);
      const provenance = buildProvenance({
        author,
        tool: 'remember',
        version: services.version ?? 'unknown',
        now: services.clock.now(),
      });
      // CHAMBA-021 review: check EVERY free-text field, not only content —
      // an injection could just as easily be smuggled in via `key`.
      const instrLike = mergeInstructionLike(
        detectInstructionLike(key),
        detectInstructionLike(content),
      );
      const instrWarning =
        instrLike.matched.length > 0
          ? `\n\n⚠ El contenido parece traer instrucciones para agentes (${instrLike.matched.join(', ')}). La nota queda como propuesto con flag: revisar.`
          : '';

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
        const memory = await store.remember({
          key,
          content,
          tags,
          provenance,
          flagRevisar: instrLike.matched.length > 0,
        });
        logger.info({ tool: TOOL_NAME, key, path: memory.path }, 'memory saved (bound-unsyncable)');
        return {
          content: [
            {
              type: 'text' as const,
              text: `Saved memory '${key}' to ${memory.path}\n\n⚠ parche no sincronizable: ${vaultResult.hint}${instrWarning}`,
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

      const memory = await store.remember({
        key,
        content,
        tags,
        provenance,
        flagRevisar: instrLike.matched.length > 0,
      });
      logger.info({ tool: TOOL_NAME, key, path: memory.path }, 'memory saved');

      // C5: push sync after writing (only with parche vault and autoSync enabled)
      let syncWarning: string | undefined;
      if (parcheVault?.autoSync.enabled) {
        const syncResult = await maybeAutoSync(services, logger, parcheVault, 'push');
        syncWarning = syncResult.warning;
      }

      const text = syncWarning
        ? `Saved memory '${key}' to ${memory.path}\n\n⚠ ${syncWarning}${instrWarning}`
        : `Saved memory '${key}' to ${memory.path}${instrWarning}`;

      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: { saved: true, path: memory.path } as Record<string, unknown>,
      };
    },
  );
}
