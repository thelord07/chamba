/**
 * tools/vault-unlink.ts — chamba_vault_unlink MCP tool.
 *
 * PARCHE-010: Remove the parche.json binding for the given scope.
 * Does NOT remove credentials or vault files — only the binding file.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { redactSecrets, removeBinding } from '../parche/binding-ops.js';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_vault_unlink';

const DESCRIPTION =
  'Remove the parche.json binding for the given scope (workspace or global). ' +
  'Does not remove credentials or vault files — only the binding file.';

export function registerVaultUnlink(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Vault unlink',
      description: DESCRIPTION,
      inputSchema: {
        scope: z
          .enum(['workspace', 'global'])
          .optional()
          .describe(
            'Which binding to remove: "workspace" (.chamba/parche.json in the workspace root) ' +
              'or "global" (~/.chamba/parche.json). ' +
              'Defaults to "workspace" if inside a workspace, otherwise "global".',
          ),
      },
    },
    async ({ scope: scopeInput }) => {
      try {
        const result = await removeBinding(services, { scopeFlag: scopeInput });

        if (result.kind === 'error') {
          return { isError: true, content: [{ type: 'text' as const, text: result.message }] };
        }

        if (result.kind === 'none') {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No hay vínculo ${result.scope} en ${result.bindingPath}.`,
              },
            ],
            structuredContent: {
              removed: false,
              scope: result.scope,
              bindingPath: result.bindingPath,
            } as Record<string, unknown>,
          };
        }

        // result.kind === 'removed'
        const slugDesc = result.slug ? ` (${result.slug})` : '';
        const text =
          `Vínculo ${result.scope}${slugDesc} eliminado (${result.bindingPath}). ` +
          `Las credenciales y archivos del vault siguen intactos.`;

        logger.info(
          { tool: TOOL_NAME, scope: result.scope, slug: result.slug },
          'parche: unlinked',
        );

        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: {
            removed: true,
            scope: result.scope,
            bindingPath: result.bindingPath,
            slug: result.slug,
          } as Record<string, unknown>,
        };
      } catch (err) {
        const msg = redactSecrets(err instanceof Error ? err.message : String(err));
        logger.warn({ tool: TOOL_NAME, err: msg }, 'parche: unlink failed');
        return { isError: true, content: [{ type: 'text' as const, text: msg }] };
      }
    },
  );
}
