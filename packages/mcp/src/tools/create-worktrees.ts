import {
  applyOverlapCap,
  assignWorktreePorts,
  buildTicketBranch,
  computeConcurrencyBudget,
  detectGitRepos,
  editorWorkspaceDir,
  inspectRepos,
  joinPath,
  loadConfig,
  MultiRepoWorktreeManager,
  planWorktrees,
  WORKSPACE_DIR,
  type WorktreeConfig,
  WorktreeInspector,
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
  'env copy, editor workspace, optional per-worktree PORT). Reuses an existing local/remote branch or forks a ' +
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

      // Size safe parallelism from the machine so the orchestrator can fan out
      // in waves instead of launching a worker per repo and exhausting RAM.
      let budget = computeConcurrencyBudget({
        resources: services.system.resources(),
        requested: results.length,
        perWorkerMemMB: worktrees.perWorkerMemMB ?? undefined,
        cap: worktrees.maxParallel ?? undefined,
      });

      const inspector = new WorktreeInspector(services.process, services.clock);
      const inspections = await inspectRepos({
        inspector,
        fs: services.fs,
        cwd: services.cwd,
        repos: repoList,
        baseBranch: worktrees.baseBranch,
      });
      const overlapCount = inspections.reduce((n, i) => n + i.overlaps.length, 0);
      const maxWaveSize = Math.max(
        1,
        ...inspections.flatMap((i) => {
          const linked = i.worktrees.filter((w) => !w.primary);
          if (linked.length === 0) return [results.length];
          // Treat overlapping linked worktrees as wave size 1 when any overlap exists.
          return [overlapCount > 0 ? 1 : Math.max(linked.length, 1)];
        }),
      );
      budget = applyOverlapCap(budget, maxWaveSize, overlapCount);

      let portsAssigned: Array<{ path: string; port: number }> = [];
      if (worktrees.ports.enabled && services.net) {
        const paths = results
          .filter((r) => r.status !== 'skipped-not-git')
          .map((r) => r.worktreePath);
        const assigned = await assignWorktreePorts({
          net: services.net,
          fs: services.fs,
          worktreePaths: paths,
          ports: worktrees.ports,
        });
        portsAssigned = assigned.map((a) => ({ path: a.path, port: a.port }));
      }

      logger.info(
        {
          tool: TOOL_NAME,
          ticket,
          repos: results.length,
          recommendedParallelism: budget.recommended,
        },
        'create-worktrees',
      );

      const lines = results.map(
        (r) =>
          `- ${r.repo}: ${r.status} → ${r.worktreePath}${r.envCopied > 0 ? ` (${r.envCopied} env)` : ''}`,
      );
      const parallelNote =
        results.length > 1
          ? `\n\nParallelism: run up to ${budget.recommended} of these at a time — ${budget.reason}.`
          : '';
      const portNote =
        portsAssigned.length > 0
          ? `\nPorts: ${portsAssigned.map((p) => `${p.port}`).join(', ')} (written to .env.local).`
          : '';
      const text =
        `Worktrees for ${ticket} on branch ${branch} (${worktrees.layout} layout):\n${lines.join('\n')}` +
        `${workspaceFile ? `\nEditor workspace: ${workspaceFile}` : ''}` +
        parallelNote +
        portNote +
        '\n\nBranches are left open — review, commit and merge by hand.';

      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          ticket,
          branch,
          layout: worktrees.layout,
          workspaceFile,
          worktrees: results,
          recommendedParallelism: budget.recommended,
          parallelismReason: budget.reason,
          overlapCount,
          ports: portsAssigned,
        } as Record<string, unknown>,
      };
    },
  );
}
