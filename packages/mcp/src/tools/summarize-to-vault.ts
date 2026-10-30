import { ObsidianDetector, VaultWriter } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { readGitRemote } from '../git-remote.js';
import { resolveActiveParcheVaultFull } from '../parche/active-vault.js';
import { maybeAutoSync } from '../parche/autosync.js';
import { obsidianSearchRoots, type Services } from '../services.js';

const TOOL_NAME = 'chamba_summarize_to_vault';

const NO_VAULT_ERROR =
  'No Obsidian vault configured. Set CHAMBA_OBSIDIAN_VAULT_PATH or use the obsidian-mcp server';

const DESCRIPTION =
  'Write a structured summary note to the Obsidian vault under ' +
  '`proyectos/[<owner-repo>/]<date>-<slug>.md` with valid YAML frontmatter. When the ' +
  'workspace has a git remote, notes are grouped in a per-project subfolder and indexed ' +
  'so recall stays cheap. Fails clearly if no vault is configured.';

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
      // O2: full discriminated resolution — never fall through from a binding
      const vaultResult = await resolveActiveParcheVaultFull(services);

      // O2: bound-unsyncable
      if (vaultResult.kind === 'bound-unsyncable') {
        if (!vaultResult.dirExists) {
          // For invalid-binding/error, vaultDir is '' — use hint directly
          const errText =
            vaultResult.reason === 'invalid-binding' || vaultResult.reason === 'error'
              ? `No se pudo escribir la nota: ${vaultResult.hint}`
              : `No se pudo escribir la nota: la carpeta del parche (${vaultResult.vaultDir}) no existe. ${vaultResult.hint}`;
          return {
            isError: true,
            content: [{ type: 'text' as const, text: errText }],
          };
        }
        // Dir exists: write there but skip auto-sync
      }

      const parcheVault = vaultResult.kind === 'ok' ? vaultResult.vault : null;

      // R2: with a parche vault, write to its vaultDir (not the Obsidian detector)
      let vaultPath: string | undefined;
      if (vaultResult.kind === 'bound-unsyncable' && vaultResult.dirExists) {
        vaultPath = vaultResult.vaultDir;
      } else if (parcheVault) {
        vaultPath = parcheVault.vaultDir;
      } else if (vaultResult.kind !== 'bound-unsyncable') {
        const detection = await new ObsidianDetector(services.fs).detect({
          explicitPath: services.obsidianVaultPath,
          searchRoots: obsidianSearchRoots(services),
        });
        if (detection.found) vaultPath = detection.path;
      }

      if (!vaultPath) {
        logger.info({ tool: TOOL_NAME }, 'no vault configured');
        return { isError: true, content: [{ type: 'text' as const, text: NO_VAULT_ERROR }] };
      }

      const writer = new VaultWriter(services.fs, services.clock);
      const { notePath } = await writer.write({
        vaultPath,
        title,
        content,
        projectSlug,
        projectRemoteUrl: await readGitRemote(services.process, services.cwd),
      });
      logger.info({ tool: TOOL_NAME, notePath }, 'note written to vault');

      // C5: push auto-sync after writing if active vault is a parche vault (and autoSync enabled)
      // O2: if bound-unsyncable with dir existing, show hint instead
      let syncWarning: string | undefined;
      if (vaultResult.kind === 'bound-unsyncable') {
        syncWarning = `parche no sincronizable: ${vaultResult.hint}`;
      } else if (parcheVault?.autoSync.enabled) {
        const syncResult = await maybeAutoSync(services, logger, parcheVault, 'push');
        syncWarning = syncResult.warning;
      }

      const text = syncWarning
        ? `Wrote note to ${notePath}\n\n⚠ ${syncWarning}`
        : `Wrote note to ${notePath}`;

      return { content: [{ type: 'text' as const, text }] };
    },
  );
}
