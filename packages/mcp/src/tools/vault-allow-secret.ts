/**
 * tools/vault-allow-secret.ts — chamba_vault_allow_secret MCP tool.
 *
 * D-Q2 (CHAMBA-021 §9, owner decision): this tool NEVER writes the allowlist.
 * It only validates `{fingerprint, path}` and returns the exact CLI command
 * for the person to run themselves. The CLI (`vault allow-secret`) requires an
 * interactive TTY and asks the person to retype the path to confirm — so an
 * agent (potentially manipulated by a prompt-injected note) cannot self-confirm
 * a secret upload by calling this tool with `confirm: true`.
 */

import { allowSecretHint } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_vault_allow_secret';

const DESCRIPTION =
  'Mark a secret-scanner finding as a false positive. This tool does NOT write anything — ' +
  'it validates the fingerprint/path and returns the exact `vault allow-secret` CLI command. ' +
  'Only a person running that command in their own interactive terminal (retyping the path ' +
  'to confirm) can actually exempt the finding — this prevents an agent from self-confirming ' +
  'a possible secret for upload.';

const FINGERPRINT_RE = /^[0-9a-f]{12}$/i;

export function registerVaultAllowSecret(
  server: McpServer,
  logger: Logger,
  _services: Services,
): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Vault allow-secret (command only)',
      description: DESCRIPTION,
      inputSchema: {
        fingerprint: z
          .string()
          .describe('The 12-hex-char fingerprint reported for the finding (never the value).'),
        path: z.string().describe('The vault-relative path the finding was reported for.'),
      },
    },
    async ({ fingerprint, path }) => {
      if (!FINGERPRINT_RE.test(fingerprint)) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'fingerprint inválido: debe ser 12 caracteres hexadecimales.',
            },
          ],
        };
      }
      if (path.trim().length === 0) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: 'path no puede estar vacío.' }],
        };
      }

      const command = allowSecretHint(fingerprint, path);
      logger.info({ tool: TOOL_NAME, path }, 'vault-allow-secret: command built (no write)');

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `Esta tool no marca nada por sí sola. Corre este comando en tu propia terminal ` +
              `(te va a pedir re-escribir la ruta para confirmar):\n\n${command}`,
          },
        ],
        structuredContent: { command, wrote: false } as Record<string, unknown>,
      };
    },
  );
}
