/**
 * tools/vault-join.ts — chamba_vault_join MCP tool.
 * Joins a parche group vault, optionally with a custom vault directory.
 * Implements the adoption gate (PARCHE-009): if the vault has syncable files,
 * returns a needsConfirmation response unless confirmUpload:true is passed.
 * The token is never returned in the response.
 */

import { hostname } from 'node:os';
import {
  CredentialsStore,
  InvalidJoinInputError,
  joinInRepoHint,
  joinOnce,
  linkHint,
  ParcheAlreadyMemberError,
  ParcheNotFoundError,
  ParcheRateLimitedError,
  parseJoinInput,
  resolveServerUrl,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import {
  checkAdoptionGate,
  finalizeAdoption,
  formatSyncOutput,
  gateStructuredDetails,
  getAdoptionSummary,
  persistBindingAfterJoin,
  prepareJoinVaultDir,
  redactSecrets,
  resolveDefaultDir,
  resolveJoinScope,
  resumeJoin,
} from '../parche/binding-ops.js';
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
              'Required when the vault has files and you want to proceed.',
          ),
        scope: z
          .enum(['workspace', 'global'])
          .optional()
          .describe(
            'Where to save the parche binding: "workspace" (inside the nearest .chamba/parche.json) ' +
              'or "global" (~/.chamba/parche.json). Required when inside a workspace.',
          ),
      },
    },
    async ({ code, name, email, deviceLabel, dir, confirmUpload, scope: scopeInput }) => {
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
          const resume = await resumeJoin(services, { server: server_, code: parsed.code, dir });
          if (resume.kind === 'ambiguous') {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text:
                    'Hay más de un vault pendiente de confirmar para este código. ' +
                    'Especifica el directorio con `dir` para identificar cuál confirmar.',
                },
              ],
            };
          }
          if (resume.kind === 'legacy') {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text:
                    `Hay una adopción pendiente creada por una versión anterior para "${resume.slug}" ` +
                    `(${resume.vaultDir}). No se confirmó ni se usó la invitación. Confírmala con ` +
                    `\`chamba_vault_link\` (slug "${resume.slug}", dir "${resume.vaultDir}", confirmUpload: true) ` +
                    `o \`${linkHint(resume.slug, resume.vaultDir, { yes: true })}\`.`,
                },
              ],
              structuredContent: {
                legacyPending: true,
                slug: resume.slug,
                vaultDir: resume.vaultDir,
              } as Record<string, unknown>,
            };
          }
          if (resume.kind === 'resumed') {
            logger.info(
              { tool: TOOL_NAME, slug: resume.slug, vault: resume.vaultDir },
              'parche: adopted',
            );
            const syncOut = formatSyncOutput(resume.syncResult);
            const adoptText = [
              `Joined group vault: ${resume.slug}`,
              `Vault location: ${resume.vaultDir}`,
              `First sync: pushed ${syncOut.pushed}, pulled ${syncOut.pulled}, conflicts ${resume.syncResult.conflicts.length}`,
            ].join('\n');
            return {
              content: [{ type: 'text' as const, text: adoptText }],
              structuredContent: {
                slug: resume.slug,
                vaultDir: resume.vaultDir,
                ...syncOut,
              } as Record<string, unknown>,
            };
          }
          // resume.kind === 'none' → fall through to normal join
        }

        // AC6: Resolve scope BEFORE any network call (no fallback to 'global' for needs-scope).
        const scopeResolution = await resolveJoinScope(services, scopeInput);
        if (scopeResolution.kind === 'error') {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: scopeResolution.message }],
          };
        }
        if (scopeResolution.kind === 'needs-scope') {
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `Este directorio es parte del workspace "${scopeResolution.wsRoot}".\n` +
                  `¿Quieres unir el vault al workspace (scope: workspace) o de forma global (scope: global)?\n` +
                  `Vuelve a llamar con scope: "workspace" o scope: "global".`,
              },
            ],
            structuredContent: {
              needsScope: true,
              workspaceRoot: scopeResolution.wsRoot,
            } as Record<string, unknown>,
          };
        }
        // scopeResolution.kind === 'resolved'
        const resolvedScope = scopeResolution.scope;
        const wsRootForBinding = scopeResolution.wsRoot;

        // AC6: If scope=workspace and no dir given, try <wsRoot>/vault as default dir.
        const defaultDir = !dir
          ? await resolveDefaultDir(services, { scope: resolvedScope, wsRoot: wsRootForBinding })
          : undefined;
        const effectiveDir = dir ?? defaultDir;

        // Validate dir via binding-ops (only for new joins)
        let canonicalDir: string | undefined;
        if (effectiveDir) {
          const prepResult = await prepareJoinVaultDir(services, {
            dirInput: effectiveDir,
            allowInRepo: false, // D5: no allowInRepo in MCP tool
            server: server_,
          });
          if (prepResult.kind === 'in-repo') {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text:
                    `La ruta "${effectiveDir}" está dentro de un repositorio git. ` +
                    `Usa la CLI con --allow-in-repo para permitirlo:\n` +
                    `  ${joinInRepoHint(effectiveDir)}`,
                },
              ],
            };
          }
          if (prepResult.kind === 'error') {
            return {
              isError: true,
              content: [{ type: 'text' as const, text: prepResult.message }],
            };
          }
          canonicalDir = prepResult.canonicalDir;
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

        // Build adoption summary via binding-ops (keeps buildAdoptionSummary out of tools/)
        const summary = await getAdoptionSummary(services, result.vaultDir);

        // Gate: if there are files and confirmUpload is not true, return needsConfirmation.
        const gate = checkAdoptionGate(summary, confirmUpload);
        if (gate.kind === 'needs-confirmation') {
          const gateDetails = gateStructuredDetails(gate);
          logger.info(
            { tool: TOOL_NAME, slug: result.slug, fileCount: gate.fileCount },
            'parche: join needs confirmation',
          );

          // R11: write parche.json even on needsConfirmation (best-effort).
          try {
            await persistBindingAfterJoin(services, {
              scope: resolvedScope as 'workspace' | 'global',
              wsRoot: wsRootForBinding,
              server: server_,
              slug: result.slug,
              vaultDir: result.vaultDir,
            });
          } catch {
            // Best-effort — do not fail
          }

          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `El vault "${result.vaultDir}" tiene ${gate.fileCount} archivo(s) sincronizable(s).\n` +
                  `Archivos ignorados: ${gate.ignoredCount}\n` +
                  (gate.sample.length > 0
                    ? `Muestra (primeros ${gate.sample.length}):\n${gate.sample.map((p) => `  - ${p}`).join('\n')}\n`
                    : '') +
                  `\nPara confirmar la subida, vuelve a llamar con el mismo código, el mismo dir${dir ? ` ("${dir}")` : ''}, y confirmUpload: true.`,
              },
            ],
            structuredContent: {
              needsConfirmation: true,
              slug: result.slug,
              vaultDir: result.vaultDir,
              ...gateDetails,
            } as Record<string, unknown>,
          };
        }

        // Gate passed: finalize adoption via binding-ops (clears pendingAdoption + syncOnce)
        const creds2 = new CredentialsStore(services.fs, services.homedir);
        const cred = await creds2.get(server_, result.slug);
        if (!cred) {
          return {
            isError: true,
            content: [{ type: 'text' as const, text: 'Error interno: credencial no encontrada.' }],
          };
        }

        const syncResult = await finalizeAdoption(services, {
          server: server_,
          slug: result.slug,
          vaultDir: result.vaultDir,
          cred,
        });

        logger.info(
          { tool: TOOL_NAME, slug: result.slug, vault: result.vaultDir },
          'parche: joined',
        );

        // PARCHE-010: persist parche.json binding (best-effort; tool returns success even if write fails)
        let bindingNote = '';
        try {
          const bindRes = await persistBindingAfterJoin(services, {
            scope: resolvedScope as 'workspace' | 'global',
            wsRoot: wsRootForBinding,
            server: server_,
            slug: result.slug,
            vaultDir: result.vaultDir,
          });
          if (bindRes) {
            bindingNote = `\nBinding saved: ${bindRes.bindingPath}`;
          }
        } catch {
          // Best-effort — do not fail the join
        }

        const syncOut = formatSyncOutput(syncResult);
        const text =
          [
            `Joined group vault: ${result.slug}`,
            `Vault location: ${result.vaultDir}`,
            `First sync: pushed ${syncOut.pushed}, pulled ${syncOut.pulled}, conflicts ${syncResult.conflicts.length}`,
          ].join('\n') + bindingNote;

        return {
          content: [{ type: 'text' as const, text }],
          structuredContent: {
            slug: result.slug,
            vaultDir: result.vaultDir,
            ...syncOut,
          } as Record<string, unknown>,
        };
      } catch (err) {
        let msg: string;
        if (err instanceof InvalidJoinInputError) {
          // R1/AC4: never repeat the user input (it may contain a pch_ token)
          msg = 'código o link inválido';
        } else if (err instanceof ParcheNotFoundError) {
          msg = 'código inválido, vencido o agotado';
        } else if (err instanceof ParcheAlreadyMemberError) {
          msg =
            'ya eres miembro en este grupo (próximamente: vault login para máquinas existentes)';
        } else if (err instanceof ParcheRateLimitedError) {
          msg = 'demasiados intentos, espera un minuto';
        } else {
          msg = redactSecrets(err instanceof Error ? err.message : String(err));
        }
        logger.warn({ tool: TOOL_NAME, err: msg }, 'parche: join failed');
        return {
          isError: true,
          content: [{ type: 'text' as const, text: msg }],
        };
      }
    },
  );
}
