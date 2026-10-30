import { FilesystemMemoryStore } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { resolveActiveParcheVaultFull } from '../parche/active-vault.js';
import { maybeAutoSync } from '../parche/autosync.js';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_recall';

const DESCRIPTION =
  'Search persisted memories (case-insensitive substring over key, tags and content). ' +
  'With an active parche vault: pulls if stale, then searches both the vault memory ' +
  '(labelled "grupo <slug>") and personal local memory (labelled "personal, solo esta máquina"). ' +
  'Without parche: searches only the local .chamba/memory/.';

export function registerRecall(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Recall',
      description: DESCRIPTION,
      inputSchema: {
        query: z.string().describe('Keywords to search for.'),
      },
    },
    async ({ query }) => {
      const vaultResult = await resolveActiveParcheVaultFull(services);

      // O2: bound-unsyncable → include warning; if dirExists, still read from binding vault
      if (vaultResult.kind === 'bound-unsyncable') {
        const warning = `⚠ parche no sincronizable: ${vaultResult.hint}`;
        if (vaultResult.dirExists) {
          // Dir exists: read from binding vault dir (same as load-context)
          const bindingStore = new FilesystemMemoryStore(
            services.fs,
            services.clock,
            vaultResult.vaultDir,
            { dir: 'memory' },
          );
          const personalStore = new FilesystemMemoryStore(
            services.fs,
            services.clock,
            services.cwd,
          );
          const [bindingMatches, personalMatches] = await Promise.all([
            bindingStore.recall(query),
            personalStore.recall(query),
          ]);
          const allMatches = [
            ...bindingMatches.map((m) => ({ ...m, origin: 'vault (no sync)' })),
            ...personalMatches.map((m) => ({ ...m, origin: 'personal, solo esta máquina' })),
          ];
          const matchText =
            allMatches.length === 0
              ? `No memories matched "${query}".`
              : allMatches
                  .map((m) => `### ${m.key} (\`${m.path}\`) [${m.origin}]\n${m.content}`)
                  .join('\n\n');
          return {
            content: [{ type: 'text' as const, text: `${matchText}\n\n${warning}` }],
            structuredContent: { matches: allMatches } as Record<string, unknown>,
          };
        }
        // Dir missing: search only personal memory, include warning
        const store = new FilesystemMemoryStore(services.fs, services.clock, services.cwd);
        const matches = await store.recall(query);
        const text =
          `${warning}\n\n` +
          (matches.length === 0
            ? `No memories matched "${query}".`
            : matches.map((m) => `### ${m.key} (\`${m.path}\`)\n${m.content}`).join('\n\n'));
        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: { matches: [] } as Record<string, unknown>,
        };
      }

      const parcheVault = vaultResult.kind === 'ok' ? vaultResult.vault : null;

      // C5 gate decision 3: auto pull before reading when active vault is parche (and autoSync enabled)
      let syncWarning: string | undefined;
      if (parcheVault?.autoSync.enabled) {
        const syncResult = await maybeAutoSync(services, logger, parcheVault, 'pull');
        syncWarning = syncResult.warning;
      }

      if (!parcheVault) {
        // No parche vault: original behavior — read from cwd/.chamba/memory/
        const store = new FilesystemMemoryStore(services.fs, services.clock, services.cwd);
        const matches = await store.recall(query);
        logger.info({ tool: TOOL_NAME, query, matches: matches.length }, 'recall (local)');

        const text =
          matches.length === 0
            ? `No memories matched "${query}".`
            : matches.map((m) => `### ${m.key} (\`${m.path}\`)\n${m.content}`).join('\n\n');

        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: {
            matches: matches.map((m) => ({
              key: m.key,
              path: m.path,
              tags: m.tags,
              content: m.content,
            })),
          } as Record<string, unknown>,
        };
      }

      // With parche vault: gate decision 4b — search BOTH vault/memory/ AND cwd/.chamba/memory/
      const vaultStore = new FilesystemMemoryStore(
        services.fs,
        services.clock,
        parcheVault.vaultDir,
        { dir: 'memory' },
      );
      const personalStore = new FilesystemMemoryStore(services.fs, services.clock, services.cwd);

      const [vaultMatches, personalMatches] = await Promise.all([
        vaultStore.recall(query),
        personalStore.recall(query),
      ]);

      logger.info(
        { tool: TOOL_NAME, query, vault: vaultMatches.length, personal: personalMatches.length },
        'recall (parche + personal)',
      );

      const allMatches: Array<{
        key: string;
        path: string;
        tags: string[];
        content: string;
        origin: string;
      }> = [
        ...vaultMatches.map((m) => ({ ...m, origin: `grupo ${parcheVault.slug}` })),
        ...personalMatches.map((m) => ({ ...m, origin: 'personal, solo esta máquina' })),
      ];

      let text: string;
      if (allMatches.length === 0) {
        text = `No memories matched "${query}".`;
      } else {
        text = allMatches
          .map((m) => `### ${m.key} (\`${m.path}\`) [${m.origin}]\n${m.content}`)
          .join('\n\n');
      }

      if (syncWarning) {
        text = `${text}\n\n⚠ ${syncWarning}`;
      }

      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: {
          matches: allMatches,
        } as Record<string, unknown>,
      };
    },
  );
}
