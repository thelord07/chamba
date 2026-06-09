import { FilesystemMemoryStore } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_remember';

const DESCRIPTION =
  'Persist a piece of knowledge across sessions as an editable markdown file under ' +
  '`.chamba/memory/<key>.md`. Re-remembering an existing key appends a timestamped ' +
  'section instead of overwriting.';

export function registerRemember(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Remember',
      description: DESCRIPTION,
      inputSchema: {
        key: z.string().describe('Short identifier, e.g. "auth-decisions".'),
        content: z.string().describe('What to remember (markdown).'),
        tags: z.array(z.string()).optional().describe('Optional tags for search.'),
      },
    },
    async ({ key, content, tags }) => {
      const store = new FilesystemMemoryStore(services.fs, services.clock, services.cwd);
      const memory = await store.remember({ key, content, tags });
      logger.info({ tool: TOOL_NAME, key, path: memory.path }, 'memory saved');
      return {
        content: [{ type: 'text', text: `Saved memory '${key}' to ${memory.path}` }],
        structuredContent: { saved: true, path: memory.path } as Record<string, unknown>,
      };
    },
  );
}
