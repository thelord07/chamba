import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { createNodeServices, type Services } from './services.js';
import { registerCleanupWorktree } from './tools/cleanup-worktree.js';
import { registerCleanupWorktrees } from './tools/cleanup-worktrees.js';
import { registerCreateWorktree } from './tools/create-worktree.js';
import { registerCreateWorktrees } from './tools/create-worktrees.js';
import { registerGeneratePlan } from './tools/generate-plan.js';
import { registerGetAgentConfig } from './tools/get-agent-config.js';
import { registerListWorktrees } from './tools/list-worktrees.js';
import { registerLoadContext } from './tools/load-context.js';
import { registerRecall } from './tools/recall.js';
import { registerRemember } from './tools/remember.js';
import { registerReviewPlan } from './tools/review-plan.js';
import { registerSavePlan } from './tools/save-plan.js';
import { registerSummarizeToVault } from './tools/summarize-to-vault.js';
import { registerVaultStatus } from './tools/vault-status.js';
import { registerWorkspaceInit } from './tools/workspace-init.js';
import { registerWorkspaceReload } from './tools/workspace-reload.js';
import { registerWorkspaceShow } from './tools/workspace-show.js';

export const SERVER_NAME = 'chamba';
export const SERVER_VERSION = '0.0.0';

/**
 * Build the chamba MCP server with every tool registered.
 *
 * Transport-agnostic: `main.ts` wires it to stdio, tests wire it to an
 * in-memory transport. `services` is injectable so tests can pass a
 * `MemoryFilesystem` and a fixed cwd.
 */
export function createServer(logger: Logger, services: Services = createNodeServices()): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  registerWorkspaceShow(server, logger, services);
  registerWorkspaceInit(server, logger, services);
  registerWorkspaceReload(server, logger, services);
  registerLoadContext(server, logger, services);
  registerSummarizeToVault(server, logger, services);
  registerVaultStatus(server, logger, services);
  registerGeneratePlan(server, logger, services);
  registerReviewPlan(server, logger, services);
  registerSavePlan(server, logger, services);
  registerCreateWorktree(server, logger, services);
  registerListWorktrees(server, logger, services);
  registerCleanupWorktree(server, logger, services);
  registerCreateWorktrees(server, logger, services);
  registerCleanupWorktrees(server, logger, services);
  registerRemember(server, logger, services);
  registerRecall(server, logger, services);
  registerGetAgentConfig(server, logger, services);

  return server;
}
