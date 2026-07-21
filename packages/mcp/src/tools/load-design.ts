import {
  collectDesignRefs,
  DESIGN_DIR,
  type Design,
  type DesignConventions,
  type DesignRef,
  joinPath,
  loadDesignConventions,
  rankDesigns,
  readDesign,
  WORKSPACE_DIR,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_load_design';

const DESCRIPTION =
  'Resolve the design source(s) relevant to a task (NO LLM). Scans `.chamba/design/*.md` ' +
  '(project, then ~/.chamba/design) — each pointer LINKS an external design: a Figma URL, a ' +
  'folder of mockups/specs, and/or a standalone prototype (.html/.zip). Returns the best ' +
  'matches with their brief, the Figma link, and a listing of the folder assets (image + ' +
  'prototype paths for the editor to open; specs inline), plus the saved UI-architecture ' +
  "preference. chamba links and lists — your editor's model + Figma MCP/browser does the visual " +
  'work. Ships empty: create `.chamba/design/<name>.md` (or run /design) to link a source.';

export function registerLoadDesign(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Load design source',
      description: DESCRIPTION,
      inputSchema: {
        task: z.string().describe('The task/ticket to find a relevant design source for.'),
        max: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('Max design sources to return with assets (default 3).'),
      },
    },
    async ({ task, max }) => {
      const dirs = [
        joinPath(services.cwd, WORKSPACE_DIR, DESIGN_DIR),
        joinPath(services.homedir, WORKSPACE_DIR, DESIGN_DIR),
      ];
      const refs = await collectDesignRefs(services.fs, dirs);
      const conventions = await loadDesignConventions(services.fs, dirs);

      const matched: Design[] = [];
      for (const ref of rankDesigns(task, refs, max ?? 3)) {
        const design = await readDesign(services.fs, ref, services.homedir);
        if (design) matched.push(design);
      }

      logger.info(
        { tool: TOOL_NAME, available: refs.length, matched: matched.length },
        'load-design',
      );

      return {
        content: [{ type: 'text', text: render(matched, refs, conventions) }],
        structuredContent: {
          designs: matched.map((d) => ({
            name: d.name,
            description: d.description,
            figma: d.figma,
            folder: d.folder,
            prototype: d.prototype,
            brief: d.brief,
            assets: d.assets,
          })),
          available: refs.map((r) => ({ name: r.name, description: r.description })),
          conventions,
        } as Record<string, unknown>,
      };
    },
  );
}

function render(matched: Design[], all: DesignRef[], conv: DesignConventions): string {
  const lines: string[] = [];

  lines.push('## UI architecture');
  if (conv.web || conv.mobile) {
    if (conv.web) lines.push(`- web: **${conv.web}**`);
    if (conv.mobile) lines.push(`- mobile: **${conv.mobile}**`);
    lines.push('Build to this. Change it with `chamba_design_prefs`.');
  } else {
    lines.push(
      '_Not set._ For a visual ticket, ask the human which methodology (Atomic Design, ' +
        'Feature-Sliced, component-driven, …) and save it with `chamba_design_prefs` — then ' +
        'reuse it. Use the `mobile` preference for Expo/React Native tickets.',
    );
  }
  lines.push('');

  if (matched.length === 0 && all.length === 0) {
    lines.push(
      'No design sources linked. Create `.chamba/design/<name>.md` (frontmatter ' +
        '`{ name, description, figma?, folder?, prototype? }`) or run `/design link <name> ' +
        '<folder|.html|.zip|figma-url>` to point chamba at your mockups/prototype.',
    );
    return lines.join('\n');
  }

  if (matched.length > 0) {
    lines.push(`## Relevant design sources (${matched.length})`, '');
    for (const d of matched) {
      lines.push(`### ${d.name}${d.description ? ` — ${d.description}` : ''}`);
      if (d.figma) lines.push(`- Figma: ${d.figma} (use your Figma MCP for exact tokens)`);
      if (d.prototype) lines.push(`- Prototype: \`${d.prototype}\` — open/run it as the target`);
      const images = d.assets.filter((a) => a.kind === 'image');
      const protos = d.assets.filter((a) => a.kind === 'prototype');
      if (images.length > 0)
        lines.push(
          `- Mockups (${images.length}): ${images.map((a) => `\`${a.path}\``).join(', ')}`,
        );
      for (const p of protos)
        lines.push(`- Prototype file: \`${p.path}\` — open in a browser (unzip if .zip)`);
      const specs = d.assets.filter((a) => a.kind === 'spec');
      for (const s of specs) {
        lines.push(`- Spec \`${s.name}\`:`);
        if (s.excerpt) lines.push('', s.excerpt, '');
      }
      if (d.brief) lines.push('', d.brief, '');
    }
  } else {
    lines.push('No design source matched this task directly.', '');
  }

  if (all.length > 0) {
    lines.push('## All linked design sources');
    for (const r of all) lines.push(`- **${r.name}** — ${r.description}`);
  }
  return lines.join('\n');
}
