import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { registerWorkspaceShow } from './tools/workspace-show.js';

export const SERVER_NAME = 'chamba';
export const SERVER_VERSION = '0.0.0';

/**
 * Build the chamba MCP server with every tool registered.
 *
 * Kept transport-agnostic on purpose: `main.ts` wires it to stdio, and tests
 * wire it to an in-memory transport. The server itself never touches stdio.
 */
export function createServer(logger: Logger): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerWorkspaceShow(server, logger);

  return server;
}
