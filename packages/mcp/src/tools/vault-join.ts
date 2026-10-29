/**
 * tools/vault-join.ts — chamba_vault_join MCP tool.
 * Joins a parche group, creates the vault, saves credentials (0600), runs first sync.
 * The token is never returned in the response.
 */

import { hostname } from 'node:os';
import {
  joinOnce,
  ParcheAlreadyMemberError,
  ParcheNotFoundError,
  ParcheRateLimitedError,
  parseJoinInput,
  resolveServerUrl,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_vault_join';

const DESCRIPTION =
  'Join a parche group vault using an invite code or link. ' +
  'Creates the local vault, saves credentials, and runs the first sync. ' +
  'The token is never returned.';

export function registerVaultJoin(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Vault join',
      description: DESCRIPTION,
      inputSchema: {
        code: z
          .string()
          .describe('Invite code (XXXX-XXXX) or full link (https://server/j/XXXX-XXXX).'),
        name: z.string().describe('Your display name for the group.'),
        email: z.string().describe('Your email address.'),
        deviceLabel: z
          .string()
          .optional()
          .describe('Label for this device (default: hostname). Omit to use hostname.'),
      },
    },
    async ({ code, name, email, deviceLabel }) => {
      try {
        const parsed = parseJoinInput(code);
        const server_ = resolveServerUrl({
          linkServer: parsed.server,
          envUrl: services.parcheServerUrl,
        });
        const label = deviceLabel !== undefined ? deviceLabel : hostname();

        const result = await joinOnce(
          { fs: services.fs, http: services.http, hash: services.hash, clock: services.clock },
          {
            vaultDir: '',
            server: server_,
            homedir: services.homedir,
            joinRequest: {
              code: parsed.code,
              name,
              email,
              // Omit label when empty (gate rule)
              ...(label ? { deviceLabel: label } : {}),
            },
          },
        );

        logger.info({ tool: TOOL_NAME, slug: result.slug, vault: result.vaultDir }, 'vault joined');

        const { pushed, pulled, conflicts } = result.summary;
        const text = [
          `Joined group vault: ${result.slug}`,
          `Vault location: ${result.vaultDir}`,
          `First sync: pushed ${pushed}, pulled ${pulled}, conflicts ${conflicts.length}`,
        ].join('\n');

        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: {
            slug: result.slug,
            vaultDir: result.vaultDir,
            pushed,
            pulled,
            conflicts: conflicts.length,
          } as Record<string, unknown>,
        };
      } catch (err) {
        let msg: string;
        if (err instanceof ParcheNotFoundError) {
          msg = 'código inválido, vencido o agotado';
        } else if (err instanceof ParcheAlreadyMemberError) {
          msg = 'ya eres miembro: usa `vault login` en esta máquina (próximamente)';
        } else if (err instanceof ParcheRateLimitedError) {
          msg = 'demasiados intentos, espera un minuto';
        } else {
          msg = err instanceof Error ? err.message : String(err);
        }
        logger.warn({ tool: TOOL_NAME, err: msg }, 'vault join failed');
        return {
          isError: true,
          content: [{ type: 'text' as const, text: msg }],
        };
      }
    },
  );
}
