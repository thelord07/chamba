/**
 * tools/vault-navigate.ts — chamba_vault_navigate MCP tool (CHAMBA-017).
 *
 * Three views:
 *   - root (no args or path=INDEX.md): top-level topics, folders, unclassified count.
 *   - node (tema or path=temas/<node>.md): subtopics, direct notes, co-topics.
 *   - note (path=<other>.md): metadata, backlinks, sisters, optional body.
 *
 * Self-healing: runs VaultReindexer before answering (deadlineMs=2000, skip-lock).
 * No autosync / push triggered.
 *
 * Description instructs the agent: start at root/mapa, go down only where
 * descriptions apply, readBody only on notes whose summary/keywords match task keywords.
 */
import {
  buildVaultNav,
  loadGraphNotes,
  loadVocabulary,
  navNode,
  navNote,
  navRoot,
  ObsidianDetector,
  resolveTopic,
  safeVaultRelPath,
  VaultReindexer,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import { resolveActiveParcheVaultFull } from '../parche/active-vault.js';
import { withVaultLock } from '../parche/mutex.js';
import { markPendingReindex } from '../parche/reindex-state.js';
import { obsidianSearchRoots, type Services } from '../services.js';

const TOOL_NAME = 'chamba_vault_navigate';

const DESCRIPTION =
  'Navega la red de conocimiento del vault de Obsidian. ' +
  'Flujo recomendado: ' +
  '1) sin argumentos (o path:"INDEX.md") → vista raíz con temas, carpetas y conteos; ' +
  '2) tema:"<ruta>" → vista de nodo con subtemas y notas directas; baja solo a subtemas cuya descripción sea pertinente; ' +
  '3) path:"<nota>.md" readBody:true → lee el cuerpo de notas cuyo summary/keywords contengan ≥2 palabras clave de la tarea. ' +
  'Siempre empieza en raíz o en el mapa de chamba_load_context; evita readBody hasta confirmar pertinencia por summary.';

const NO_VAULT_ERROR =
  'No Obsidian vault configured. Set CHAMBA_OBSIDIAN_VAULT_PATH or use the obsidian-mcp server';

function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .join('/')
    .replace(/\/{2,}/g, '/');
}

// ─── Output schema (structuredContent shape) ──────────────────────────────────
// The SDK's normalizeObjectSchema only accepts z.object schemas (not discriminated unions).
// We use a flat object schema with optional fields covering all three views.

const NavItemSchema = z.object({
  titulo: z.string(),
  ruta: z.string(),
  type: z.string(),
  summary: z.string().optional(),
  keywords: z.array(z.string()),
  temas: z.array(z.string()),
  workItem: z.string().optional(),
  date: z.string().optional(),
});

const NAV_OUTPUT_SCHEMA = z.object({
  /** Discriminator: 'root' | 'node' | 'note' */
  vista: z.string(),
  // ── Root view fields ──
  /** Root: topic entries (array of objects). Use this field when vista === 'root'. */
  temasRaiz: z
    .array(
      z.object({
        ruta: z.string(),
        descripcion: z.string(),
        aliases: z.array(z.string()),
        conteoSubarbol: z.number(),
      }),
    )
    .optional(),
  carpetas: z.array(z.object({ ruta: z.string(), conteo: z.number() })).optional(),
  sinClasificar: z.number().optional(),
  // ── Node view fields ──
  ruta: z.string().optional(),
  descripcion: z.string().optional(),
  padre: z.string().optional(),
  subtemas: z
    .array(z.object({ ruta: z.string(), descripcion: z.string(), conteoSubarbol: z.number() }))
    .optional(),
  notasDirectas: z.array(NavItemSchema).optional(),
  coTemas: z.array(z.object({ tema: z.string(), conteo: z.number() })).optional(),
  // ── Note view fields ──
  titulo: z.string().optional(),
  /** Note: topic paths this note belongs to (array of strings). Use when vista === 'note'. */
  temas: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  type: z.string().optional(),
  workItem: z.string().optional(),
  related: z.array(z.string()).optional(),
  date: z.string().optional(),
  summary: z.string().optional(),
  backlinks: z.array(z.object({ titulo: z.string(), ruta: z.string() })).optional(),
  hermanas: z.array(NavItemSchema).optional(),
  body: z.string().optional(),
  truncated: z.boolean().optional(),
  // ── Shared ──
  notice: z.string().optional(),
});

type NavOutput = z.infer<typeof NAV_OUTPUT_SCHEMA>;

// ─── Text renderers ───────────────────────────────────────────────────────────

function renderRoot(
  view: ReturnType<typeof navRoot>,
  notice?: string,
): { text: string; structured: NavOutput } {
  const lines: string[] = ['# Vault — vista raíz', ''];

  if (view.temas.length > 0) {
    lines.push('## Temas principales');
    for (const t of view.temas) {
      const aliases = t.aliases.length > 0 ? ` (alias: ${t.aliases.join(', ')})` : '';
      lines.push(`- \`${t.ruta}\`${aliases} — ${t.descripcion} · ${t.conteoSubarbol} nota(s)`);
    }
    lines.push('');
  } else {
    lines.push('(sin temas en vocabulario)', '');
  }

  if (view.carpetas.length > 0) {
    lines.push('## Carpetas');
    for (const c of view.carpetas) {
      lines.push(`- ${c.ruta}: ${c.conteo} nota(s)`);
    }
    lines.push('');
  }

  lines.push(`Sin clasificar: ${view.sinClasificar} nota(s)`);

  if (notice) lines.push('', `> (${notice})`);

  return {
    text: lines.join('\n'),
    structured: {
      vista: 'root',
      temasRaiz: view.temas,
      carpetas: view.carpetas,
      sinClasificar: view.sinClasificar,
      notice,
    },
  };
}

function renderNode(
  view: NonNullable<ReturnType<typeof navNode>>,
  notice?: string,
): { text: string; structured: NavOutput } {
  const lines: string[] = [`# Nodo: \`${view.ruta}\``, ''];
  lines.push(`${view.descripcion}`);
  if (view.padre) lines.push(``, `Padre: \`${view.padre}\``);
  lines.push('');

  if (view.subtemas.length > 0) {
    lines.push('## Subtemas');
    for (const s of view.subtemas) {
      lines.push(`- \`${s.ruta}\` — ${s.descripcion} · ${s.conteoSubarbol} nota(s)`);
    }
    lines.push('');
  }

  if (view.notasDirectas.length > 0) {
    lines.push('## Notas directas');
    for (const n of view.notasDirectas) {
      const kws = n.keywords.length > 0 ? ` · claves: ${n.keywords.slice(0, 5).join(', ')}` : '';
      const wi = n.workItem ? ` · work-item: ${n.workItem}` : '';
      const dt = n.date ? ` · ${n.date}` : '';
      const summ = n.summary ? ` — ${n.summary}` : '';
      lines.push(`- [${n.titulo}](${n.ruta})${summ}${kws}${wi}${dt}`);
    }
    lines.push('');
  } else {
    lines.push('## Notas directas', '(ninguna)', '');
  }

  if (view.coTemas.length > 0) {
    lines.push('## Co-temas');
    for (const c of view.coTemas) {
      lines.push(`- \`${c.tema}\` (${c.conteo})`);
    }
    lines.push('');
  }

  if (notice) lines.push(`> (${notice})`);

  return {
    text: lines.join('\n'),
    structured: {
      vista: 'node',
      ruta: view.ruta,
      descripcion: view.descripcion,
      padre: view.padre,
      subtemas: view.subtemas,
      notasDirectas: view.notasDirectas,
      coTemas: view.coTemas,
      notice,
    },
  };
}

function renderNote(
  view: NonNullable<ReturnType<typeof navNote>>,
  notice?: string,
): { text: string; structured: NavOutput } {
  const lines: string[] = [`# Nota: ${view.titulo}`, '', `Ruta: \`${view.ruta}\``];
  lines.push(`Tipo: ${view.type}`);
  if (view.date) lines.push(`Fecha: ${view.date}`);
  if (view.workItem) lines.push(`Work item: ${view.workItem}`);
  if (view.summary) lines.push(``, `${view.summary}`);
  lines.push('');

  if (view.temas.length > 0) {
    lines.push(`Temas: ${view.temas.map((t) => `\`${t}\``).join(', ')}`);
  }
  if (view.keywords.length > 0) {
    lines.push(`Palabras clave: ${view.keywords.join(', ')}`);
  }
  if (view.related.length > 0) {
    lines.push(`Related: ${view.related.join(', ')}`);
  }
  lines.push('');

  if (view.backlinks.length > 0) {
    lines.push('## Backlinks');
    for (const b of view.backlinks) lines.push(`- [${b.titulo}](${b.ruta})`);
    lines.push('');
  }

  if (view.hermanas.length > 0) {
    lines.push('## Notas del mismo work item');
    for (const h of view.hermanas) {
      const summ = h.summary ? ` — ${h.summary}` : '';
      lines.push(`- [${h.titulo}](${h.ruta})${summ}`);
    }
    lines.push('');
  }

  if (view.body !== undefined) {
    lines.push('## Cuerpo');
    lines.push(view.body);
    if (view.truncated) lines.push('', '> (cuerpo recortado por maxChars)');
    lines.push('');
  }

  if (notice) lines.push(`> (${notice})`);

  return {
    text: lines.join('\n'),
    structured: {
      vista: 'note',
      ruta: view.ruta,
      titulo: view.titulo,
      temas: view.temas,
      keywords: view.keywords,
      type: view.type,
      workItem: view.workItem,
      related: view.related,
      date: view.date,
      summary: view.summary,
      backlinks: view.backlinks,
      hermanas: view.hermanas,
      body: view.body,
      truncated: view.truncated,
      notice,
    },
  };
}

// ─── Tool registration ────────────────────────────────────────────────────────

/** Register `chamba_vault_navigate`. */
export function registerVaultNavigate(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Vault navigate',
      description: DESCRIPTION,
      inputSchema: {
        path: z
          .string()
          .optional()
          .describe(
            'Ruta relativa al vault (.md). "INDEX.md" → raíz; ' +
              '"temas/<nodo>.md" → nodo; otra ruta → nota.',
          ),
        tema: z
          .string()
          .optional()
          .describe('Ruta o alias de un tema (ej: "lms/cursos", "plataforma"). Resuelve alias.'),
        readBody: z
          .boolean()
          .optional()
          .describe('Incluir el cuerpo de la nota. Solo en vista de nota.'),
        maxChars: z
          .number()
          .int()
          .min(1)
          .max(20000)
          .optional()
          .describe('Máximo de caracteres del cuerpo (default 4000, máx 20000).'),
      },
      outputSchema: NAV_OUTPUT_SCHEMA,
    },
    async ({ path: inputPath, tema, readBody, maxChars }) => {
      // ── Vault resolution ────────────────────────────────────────────────────
      const vaultResult = await resolveActiveParcheVaultFull(services);
      if (vaultResult.kind === 'bound-unsyncable' && !vaultResult.dirExists) {
        return {
          isError: true,
          content: [
            { type: 'text' as const, text: `No hay vault disponible: ${vaultResult.hint}` },
          ],
        };
      }

      let vaultPath: string | undefined;
      if (vaultResult.kind === 'bound-unsyncable' && vaultResult.dirExists) {
        vaultPath = vaultResult.vaultDir;
      } else if (vaultResult.kind === 'ok') {
        vaultPath = vaultResult.vault.vaultDir;
      } else {
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

      // ── Early path validation (before any side effects) ─────────────────────
      // Validates once, normalizes `\`→`/` and `.` segments (so `./INDEX.md`
      // becomes `INDEX.md`). Uses win32 style to also reject CON.md, trailing dots.
      let rel: string | undefined;
      if (inputPath) {
        const pathCheck = safeVaultRelPath(inputPath, 'win32');
        if ('error' in pathCheck) {
          return { isError: true, content: [{ type: 'text' as const, text: pathCheck.error }] };
        }
        rel = pathCheck.ok;
      }

      // ── Resolve vault real path (for reindex lock key + containment check) ──
      // M7: if realpath fails we track it and fail closed on containment checks.
      let vaultRealPath = vaultPath;
      let vaultRealpathResolved = false;
      try {
        vaultRealPath = await services.fs.realpath(vaultPath);
        vaultRealpathResolved = true;
      } catch {
        /* vault path not resolvable — reindex still runs, containment check fails closed */
      }
      const reindexLockKey = `reindex|${vaultRealPath}`;

      // ── Self-healing reindex (§16) ──────────────────────────────────────────
      let reindexNotice: string | undefined;

      const reindexLockResult = await withVaultLock(
        services.vaultMutex,
        reindexLockKey,
        { onBusy: 'skip', logger, label: 'vault-navigate' },
        async () => {
          return await new VaultReindexer(services.fs, vaultPath as string).reindex({
            dryRun: false,
            deadlineMs: 2000,
          });
        },
      );

      // The pending set is keyed by the raw vaultDir (that is what autosync reads);
      // only the lock key uses the realpath.
      if (reindexLockResult.skipped) {
        markPendingReindex(vaultPath);
        reindexNotice =
          'los derivados en disco pueden estar desactualizados; esta vista es correcta';
      } else if (reindexLockResult.result?.incompleto) {
        markPendingReindex(vaultPath);
        reindexNotice =
          'los derivados en disco pueden estar desactualizados; esta vista es correcta';
      }
      logger.debug(
        { archivos: reindexLockResult.result?.archivosEscritos.length ?? 0 },
        'vault-navigate reindex',
      );

      // ── Load notes + vocabulary ─────────────────────────────────────────────
      const notes = await loadGraphNotes(services.fs, vaultPath);
      const { vocabulary: vocab } = await loadVocabulary(services.fs, vaultPath);
      const nav = buildVaultNav(notes, vocab);

      logger.debug(
        { tool: TOOL_NAME, path: inputPath, tema, entradas: notes.length, readBody },
        'vault-navigate',
      );

      // ── View selection ──────────────────────────────────────────────────────

      // Case: no path, no tema → root
      if (!rel && !tema) {
        const view = navRoot(nav);
        const { text, structured } = renderRoot(view, reindexNotice);
        return { content: [{ type: 'text' as const, text }], structuredContent: structured };
      }

      // Case: tema → resolve topic → node view
      if (tema) {
        if (!vocab) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'Sin vocabulario de temas en el vault. Crea uno con chamba_vault_topics.',
              },
            ],
          };
        }
        const resolved = resolveTopic(vocab, tema);
        if ('unknown' in resolved) {
          const suggestions =
            resolved.suggestions.length > 0
              ? `Sugerencias: ${resolved.suggestions.join(', ')}`
              : 'Sin sugerencias cercanas.';
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Tema desconocido: "${tema}". ${suggestions}`,
              },
            ],
          };
        }
        const view = navNode(nav, resolved.path);
        if (!view) {
          return {
            isError: true,
            content: [
              { type: 'text' as const, text: `Nodo no encontrado en vocab: "${resolved.path}".` },
            ],
          };
        }
        const { text, structured } = renderNode(view, reindexNotice);
        return { content: [{ type: 'text' as const, text }], structuredContent: structured };
      }

      // rel is guaranteed set here (guarded by `!rel && !tema` above)
      if (!rel) {
        const view = navRoot(nav);
        const { text, structured } = renderRoot(view, reindexNotice);
        return { content: [{ type: 'text' as const, text }], structuredContent: structured };
      }

      // path normalises to INDEX.md (also catches `./INDEX.md`) → root view
      if (rel === 'INDEX.md') {
        const view = navRoot(nav);
        const { text, structured } = renderRoot(view, reindexNotice);
        return { content: [{ type: 'text' as const, text }], structuredContent: structured };
      }

      // Symlink containment check (defense in depth; M7: fail closed if vault realpath failed)
      if (!vaultRealpathResolved) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: 'No se pudo verificar la contención del path: la ruta real del vault no es resoluble; acceso denegado.',
            },
          ],
        };
      }
      const absPath = joinPath(vaultPath, rel);
      try {
        const realAbs = await services.fs.realpath(absPath);
        const vaultReal = vaultRealPath.endsWith('/') ? vaultRealPath : `${vaultRealPath}/`;
        if (!realAbs.startsWith(vaultReal) && realAbs !== vaultRealPath) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Acceso denegado: "${inputPath}" sale del vault tras resolver enlaces simbólicos.`,
              },
            ],
          };
        }
      } catch {
        // realpath failed → file doesn't exist on disk
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Archivo no encontrado: "${rel}".` }],
        };
      }

      // path = temas/<node>.md → node view
      const temaMatch = rel.match(/^temas\/(.+)\.md$/);
      if (temaMatch) {
        const nodePath = temaMatch[1] ?? '';
        if (vocab?.nodes.has(nodePath)) {
          const view = navNode(nav, nodePath);
          if (!view) {
            return {
              isError: true,
              content: [{ type: 'text' as const, text: `Nodo no encontrado: "${nodePath}".` }],
            };
          }
          const { text, structured } = renderNode(view, reindexNotice);
          return { content: [{ type: 'text' as const, text }], structuredContent: structured };
        }
        // Not a known node → fall through to note view
      }

      // path = <note>.md → note view
      // Load all note contents for body-based backlink detection
      const noteContents = new Map<string, string>();
      for (const note of notes) {
        try {
          const content = await services.fs.readFile(joinPath(vaultPath, note.path));
          noteContents.set(note.path, content);
        } catch {
          /* skip unreadable notes */
        }
      }

      const view = navNote(nav, notes, rel, {
        readBody: readBody ?? false,
        maxChars: maxChars ?? 4000,
        noteContents,
      });

      if (!view) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Nota no encontrada en el vault: "${rel}". El archivo existe en disco pero no está indexado (puede estar en una carpeta excluida).`,
            },
          ],
        };
      }

      const { text, structured } = renderNote(view, reindexNotice);
      return { content: [{ type: 'text' as const, text }], structuredContent: structured };
    },
  );
}
