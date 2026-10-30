/**
 * tools/vault-join.ts — chamba_vault_join MCP tool.
 * Joins a parche group vault, optionally with a custom vault directory.
 * Implements the adoption gate (PARCHE-009): if the vault has syncable files,
 * returns a needsConfirmation response unless confirmUpload:true is passed.
 * The token is never returned in the response.
 */

import { hostname } from 'node:os';
import {
  buildAdoptionSummary,
  CredentialsStore,
  expandTilde,
  joinOnce,
  joinPath,
  lexicalNormalize,
  ParcheAlreadyMemberError,
  ParcheNotFoundError,
  ParcheRateLimitedError,
  parseJoinInput,
  prepareVaultDir,
  readState,
  resolveServerUrl,
  resolveVaultDir,
  syncOnce,
  VaultDirValidationError,
  writeState,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_vault_join';

const DESCRIPTION =
  'Join a parche group vault using an invite code or link. ' +
  'Creates the local vault, saves credentials, and runs the first sync. ' +
  'If the vault directory has existing files, returns needsConfirmation unless confirmUpload:true. ' +
  'The token is never returned. ' +
  'Note: to use a vault directory inside a git repo, use the CLI with --allow-in-repo.';

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
        dir: z
          .string()
          .optional()
          .describe(
            'Absolute local path for the vault directory. ~ is expanded. ' +
              'Omit to use the default location (resolveVaultDir).',
          ),
        confirmUpload: z
          .boolean()
          .optional()
          .describe(
            'Set to true to confirm uploading existing files in the vault directory. ' +
              'Required when syncableCount > 0 and you want to proceed.',
          ),
      },
    },
    async ({ code, name, email, deviceLabel, dir, confirmUpload }) => {
      try {
        const parsed = parseJoinInput(code);
        const server_ = resolveServerUrl({
          linkServer: parsed.server,
          envUrl: services.parcheServerUrl,
        });
        const label = deviceLabel !== undefined ? deviceLabel : hostname();

        // PARCHE-009: if confirmUpload:true, first try to resume an existing pending vault.
        // This MUST happen BEFORE prepareVaultDir to avoid the already_linked rejection when
        // the user re-calls with the same dir they already joined.
        if (confirmUpload === true) {
          const creds = new CredentialsStore(services.fs, services.homedir);
          const allSlugs = await creds.listSlugs();
          const serverSlugs = allSlugs.filter((s) => s.server === server_);

          // Compute the candidate canonical dir (lightweight, no fs validation)
          let candidateCanonical: string | undefined;
          if (dir) {
            const expanded = expandTilde(dir, services.homedir);
            const absolute = expanded.startsWith('/') ? expanded : joinPath(services.cwd, expanded);
            const lex = lexicalNormalize(absolute);
            candidateCanonical = await services.fs.realpath(lex);
          }

          // If no dir and multiple slugs → check how many are pending
          if (!candidateCanonical && serverSlugs.length > 1) {
            const pendingOnes: string[] = [];
            for (const { server: srv, slug: sl } of serverSlugs) {
              const existingCred = await creds.get(srv, sl);
              if (!existingCred) continue;
              const existingVaultDir = resolveVaultDir(existingCred, services.homedir, sl);
              if (!(await services.fs.exists(existingVaultDir))) continue;
              const existingState = await readState(services.fs, existingVaultDir);
              if (existingState?.pendingAdoption === true) pendingOnes.push(sl);
            }
            if (pendingOnes.length > 1) {
              return {
                isError: true,
                content: [
                  {
                    type: 'text' as const,
                    text:
                      `Hay ${pendingOnes.length} vaults pendientes de confirmar (${pendingOnes.join(', ')}). ` +
                      `Especifica el directorio con \`dir\` para identificar cuál confirmar.`,
                  },
                ],
              };
            }
          }

          // Find the matching pending credential and resume it
          for (const { server: srv, slug: sl } of serverSlugs) {
            const existingCred = await creds.get(srv, sl);
            if (!existingCred) continue;
            const existingVaultDir = resolveVaultDir(existingCred, services.homedir, sl);
            if (candidateCanonical) {
              const existingCanonical = await services.fs.realpath(existingVaultDir);
              if (existingCanonical !== candidateCanonical) continue;
            }
            if (!(await services.fs.exists(existingVaultDir))) continue;
            const existingState = await readState(services.fs, existingVaultDir);
            if (existingState?.pendingAdoption !== true) continue;

            // Found — clear pendingAdoption and sync
            const cleared = { ...existingState };
            delete cleared.pendingAdoption;
            await writeState(services.fs, existingVaultDir, cleared);

            const syncResult = await syncOnce(
              { fs: services.fs, http: services.http, hash: services.hash, clock: services.clock },
              {
                vaultDir: existingVaultDir,
                server: srv,
                slug: sl,
                token: existingCred.token,
                localAuthor: existingCred.user.name,
                device: existingCred.device.label,
              },
            );

            logger.info({ tool: TOOL_NAME, slug: sl, vault: existingVaultDir }, 'vault adopted');
            const { pushed, pulled, conflicts } = syncResult;
            const adoptText = [
              `Joined group vault: ${sl}`,
              `Vault location: ${existingVaultDir}`,
              `First sync: pushed ${pushed}, pulled ${pulled}, conflicts ${conflicts.length}`,
            ].join('\n');
            return {
              content: [{ type: 'text' as const, text: adoptText }],
              structuredContent: {
                slug: sl,
                vaultDir: existingVaultDir,
                pushed,
                pulled,
                conflicts: conflicts.length,
              } as Record<string, unknown>,
            };
          }
          // No pending found — fall through to normal join (new vault, confirmUpload is still true
          // but will be treated as the first-time call)
        }

        // Validate dir with prepareVaultDir (only for new joins)
        let canonicalDir: string | undefined;
        if (dir) {
          const creds = new CredentialsStore(services.fs, services.homedir);
          const existingSlugs = await creds.listSlugs();
          const existingLinks: Array<{ server: string; slug: string; dir: string }> = [];
          for (const { server: srv, slug: sl } of existingSlugs) {
            const existingCred = await creds.get(srv, sl);
            if (existingCred) {
              existingLinks.push({
                server: srv,
                slug: sl,
                dir: resolveVaultDir(existingCred, services.homedir, sl),
              });
            }
          }

          try {
            const prepared = await prepareVaultDir(
              { fs: services.fs },
              {
                input: dir,
                homedir: services.homedir,
                cwd: services.cwd,
                slug: 'temp', // slug not known yet; validated again after join
                server: server_,
                allowInRepo: false, // D5: no allowInRepo in MCP tool
                existingLinks,
                platform: process.platform,
              },
            );
            canonicalDir = prepared.vaultDir;
          } catch (err) {
            if (err instanceof VaultDirValidationError) {
              if (err.code === 'in_repo') {
                return {
                  isError: true,
                  content: [
                    {
                      type: 'text' as const,
                      text:
                        `La ruta "${dir}" está dentro de un repositorio git. ` +
                        `Usa la CLI con --allow-in-repo para permitirlo:\n` +
                        `  chamba vault join <code> --dir "${dir}" --allow-in-repo`,
                    },
                  ],
                };
              }
              return {
                isError: true,
                content: [{ type: 'text' as const, text: err.message }],
              };
            }
            throw err;
          }
        }

        const result = await joinOnce(
          { fs: services.fs, http: services.http, hash: services.hash, clock: services.clock },
          {
            vaultDir: canonicalDir,
            server: server_,
            homedir: services.homedir,
            joinRequest: {
              code: parsed.code,
              name,
              email,
              ...(label ? { deviceLabel: label } : {}),
            },
            skipInitialSync: true, // Always use gate (D1: universal gate)
          },
        );

        // Build adoption summary
        const summary = await buildAdoptionSummary({ fs: services.fs }, result.vaultDir);

        // Gate: if there are syncable files and confirmUpload is not true, return needsConfirmation.
        // (confirmUpload:true here means this was a direct first-time call, not a resume)
        if (summary.syncableCount > 0 && confirmUpload !== true) {
          logger.info(
            { tool: TOOL_NAME, slug: result.slug, syncableCount: summary.syncableCount },
            'vault join needs confirmation',
          );
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `El vault "${result.vaultDir}" tiene ${summary.syncableCount} archivo(s) sincronizable(s).\n` +
                  `Archivos ignorados: ${summary.ignoredCount}\n` +
                  (summary.sample.length > 0
                    ? `Muestra (primeros ${summary.sample.length}):\n${summary.sample.map((p) => `  - ${p}`).join('\n')}\n`
                    : '') +
                  `\nPara confirmar la subida, vuelve a llamar con el mismo código, el mismo dir${dir ? ` ("${dir}")` : ''}, y confirmUpload: true.`,
              },
            ],
            structuredContent: {
              needsConfirmation: true,
              slug: result.slug,
              vaultDir: result.vaultDir,
              syncableCount: summary.syncableCount,
              ignoredCount: summary.ignoredCount,
              sample: summary.sample,
            } as Record<string, unknown>,
          };
        }

        // Empty vault or confirmUpload on first-time call: clear pendingAdoption and sync
        const stateFile = await readState(services.fs, result.vaultDir);
        if (stateFile?.pendingAdoption === true) {
          const cleared = { ...stateFile };
          delete cleared.pendingAdoption;
          await writeState(services.fs, result.vaultDir, cleared);
        }

        // Get the credential for sync
        const creds2 = new CredentialsStore(services.fs, services.homedir);
        const cred = await creds2.get(server_, result.slug);
        if (!cred) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: 'Error interno: credencial no encontrada.' }],
          };
        }

        const syncResult = await syncOnce(
          { fs: services.fs, http: services.http, hash: services.hash, clock: services.clock },
          {
            vaultDir: result.vaultDir,
            server: server_,
            slug: result.slug,
            token: cred.token,
            localAuthor: cred.user.name,
            device: cred.device.label,
          },
        );

        logger.info({ tool: TOOL_NAME, slug: result.slug, vault: result.vaultDir }, 'vault joined');

        const { pushed, pulled, conflicts } = syncResult;
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
