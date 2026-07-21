import {
  DESIGN_DIR,
  type DesignConventions,
  joinPath,
  KNOWN_ARCHITECTURES,
  loadDesignConventions,
  saveDesignConventions,
  WORKSPACE_DIR,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_design_prefs';

const DESCRIPTION =
  'Get or set the saved UI-architecture preference (NO LLM), so the planner asks once and ' +
  'reuses it. Call with no args to READ the current preference; pass `web` and/or `mobile` to ' +
  'SAVE it (e.g. web="atomic" for Atomic Design, mobile="screens" for Expo screens+components). ' +
  'Web and mobile are separate. Stored in `.chamba/design/conventions.json`. Suggested values ' +
  'are returned, but any string is accepted.';

export function registerDesignPrefs(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Design architecture preference',
      description: DESCRIPTION,
      inputSchema: {
        web: z
          .string()
          .optional()
          .describe('Web UI architecture to save, e.g. "atomic", "feature-sliced".'),
        mobile: z
          .string()
          .optional()
          .describe('Mobile (Expo/RN) architecture to save, e.g. "screens", "atomic".'),
      },
    },
    async ({ web, mobile }) => {
      const projectDir = joinPath(services.cwd, WORKSPACE_DIR, DESIGN_DIR);
      const dirs = [projectDir, joinPath(services.homedir, WORKSPACE_DIR, DESIGN_DIR)];

      let conventions: DesignConventions;
      let saved = false;
      if (web !== undefined || mobile !== undefined) {
        const patch: DesignConventions = {};
        if (web !== undefined) patch.web = web;
        if (mobile !== undefined) patch.mobile = mobile;
        conventions = await saveDesignConventions(services.fs, projectDir, patch);
        saved = true;
      } else {
        conventions = await loadDesignConventions(services.fs, dirs);
      }

      logger.info({ tool: TOOL_NAME, saved, ...conventions }, 'design-prefs');

      return {
        content: [{ type: 'text', text: render(conventions, saved) }],
        structuredContent: {
          conventions,
          saved,
          suggestions: KNOWN_ARCHITECTURES,
        } as Record<string, unknown>,
      };
    },
  );
}

function render(conv: DesignConventions, saved: boolean): string {
  const lines: string[] = [];
  lines.push(saved ? 'Saved UI-architecture preference:' : 'Current UI-architecture preference:');
  lines.push(`- web: ${conv.web ? `**${conv.web}**` : '_not set_'}`);
  lines.push(`- mobile: ${conv.mobile ? `**${conv.mobile}**` : '_not set_'}`);
  if (!conv.web || !conv.mobile) {
    lines.push('');
    lines.push('Suggested (any string is accepted):');
    if (!conv.web) {
      lines.push(`- web: ${KNOWN_ARCHITECTURES.web.map((a) => a.id).join(', ')}`);
    }
    if (!conv.mobile) {
      lines.push(`- mobile: ${KNOWN_ARCHITECTURES.mobile.map((a) => a.id).join(', ')}`);
    }
    lines.push('Ask the human, then call this tool again with the chosen value to save it.');
  }
  return lines.join('\n');
}
