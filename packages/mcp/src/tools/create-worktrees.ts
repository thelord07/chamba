import {
  buildTicketBranch,
  detectGitRepos,
  editorWorkspaceDir,
  joinPath,
  loadConfig,
  MultiRepoWorktreeManager,
  planWorktrees,
  WORKSPACE_DIR,
  type WorktreeConfig,
  writeEditorWorkspace,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_create_worktrees';

const DESCRIPTION =
  'Create git worktrees for a ticket across the repos it touches, driven by the ' +
  '`worktrees` block of .chamba/config.json (layout, branch prefix, base branch, ' +
  'env copy, editor workspace). Reuses an existing local/remote branch or forks a ' +
  'new one from the base. If `worktrees.command` is set, runs that command instead. ' +
  'Never merges, never pushes — branches are left open for you.';

const CONFIG_FILE = `${WORKSPACE_DIR}/config.json`;

async function resolveRepos(
  config: WorktreeConfig,
  services: Services,
  explicit?: string[],
): Promise<string[]> {
  if (explicit && explicit.length > 0) return explicit;
  if (config.repos && config.repos.length > 0) return config.repos;
  return detectGitRepos(services.fs, services.cwd);
}

export function registerCreateWorktrees(
  server: McpServer,
  logger: Logger,
  services: Services,
): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Create worktrees (multi-repo)',
      description: DESCRIPTION,
      inputSchema: {
        ticket: z.string().describe('Ticket id, e.g. TICKET-123.'),
        repos: z
          .array(z.string())
          .optional()
          .describe(
            'Repos to act on; defaults to config.worktrees.repos or autodetected git repos.',
          ),
      },
    },
    async ({ ticket, repos }) => {
      const globalPath = joinPath(services.homedir, CONFIG_FILE);
      const projectPath = joinPath(services.cwd, CONFIG_FILE);
      const { worktrees } = await loadConfig(services.fs, { globalPath, projectPath });

      // Escape hatch: shell out to the team's own script.
      if (worktrees.command) {
        const cmd = worktrees.command
          .replaceAll('{ticket}', ticket)
          .replaceAll('{repos}', (repos ?? []).join(' '));
        const result = await services.process.exec('sh', ['-c', cmd], { cwd: services.cwd });
        logger.info(
          { tool: TOOL_NAME, usedCommand: true, exitCode: result.exitCode },
          'create-worktrees (command)',
        );
        const text = `Ran worktree command (exit ${result.exitCode}).\n${result.stdout || result.stderr}`;
        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            ticket,
            usedCommand: true,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          } as Record<string, unknown>,
        };
      }

      const repoList = await resolveRepos(worktrees, services, repos);
      const branch = buildTicketBranch(worktrees.branchPrefix, ticket);

      if (repoList.length === 0) {
        const text = `No git repos found in ${services.cwd}. Set worktrees.repos in .chamba/config.json or pass repos.`;
        return {
          content: [{ type: 'text', text }],
          structuredContent: { ticket, branch, worktrees: [] } as Record<string, unknown>,
        };
      }

      const items = planWorktrees({
        workspaceRoot: services.cwd,
        ticket,
        repos: repoList,
        config: worktrees,
      });
      const results = await new MultiRepoWorktreeManager(services.process, services.fs).create({
        items,
        baseBranch: worktrees.baseBranch,
        copyEnvFiles: worktrees.copyEnvFiles,
        envPruneDirs: worktrees.envPruneDirs,
      });

      let workspaceFile: string | undefined;
      if (worktrees.editorWorkspace) {
        const dir = editorWorkspaceDir(worktrees, services.cwd, ticket);
        workspaceFile = await writeEditorWorkspace(services.fs, dir, ticket, items);
      }

      logger.info({ tool: TOOL_NAME, ticket, repos: results.length }, 'create-worktrees');

      const lines = results.map(
        (r) =>
          `- ${r.repo}: ${r.status} → ${r.worktreePath}${r.envCopied > 0 ? ` (${r.envCopied} env)` : ''}`,
      );
      const text =
        `Worktrees for ${ticket} on branch ${branch} (${worktrees.layout} layout):\n${lines.join('\n')}` +
        `${workspaceFile ? `\nEditor workspace: ${workspaceFile}` : ''}` +
        '\n\nBranches are left open — review, commit and merge by hand.';

      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          ticket,
          branch,
          layout: worktrees.layout,
          workspaceFile,
          worktrees: results,
        } as Record<string, unknown>,
      };
    },
  );
}
