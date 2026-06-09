import { FilesystemMemoryStore } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_recall';

const DESCRIPTION =
  'Search persisted memories (case-insensitive substring over key, tags and ' +
  'content) and return the matches with their paths and content.';

export function registerRecall(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Recall',
      description: DESCRIPTION,
      inputSchema: {
        query: z.string().describe('Keywords to search for.'),
      },
    },
    async ({ query }) => {
      const store = new FilesystemMemoryStore(services.fs, services.clock, services.cwd);
      const matches = await store.recall(query);
      logger.info({ tool: TOOL_NAME, query, matches: matches.length }, 'recall');

      const text =
        matches.length === 0
          ? `No memories matched "${query}".`
          : matches.map((m) => `### ${m.key} (\`${m.path}\`)\n${m.content}`).join('\n\n');

      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          matches: matches.map((m) => ({
            key: m.key,
            path: m.path,
            tags: m.tags,
            content: m.content,
          })),
        } as Record<string, unknown>,
      };
    },
  );
}
