import { renderDoctorReport, runDoctor } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { obsidianSearchRoots, type Services } from '../services.js';

const TOOL_NAME = 'chamba_doctor';

const DESCRIPTION =
  'Run environment health checks (NO LLM) and return a pass/warn/fail report: ' +
  'Node version, git, whether the cwd is a git repo, the `.chamba/workspace.md` file, ' +
  'agent config validity, the Obsidian vault connection, the log directory, and ' +
  'worktrees. Use it to see what to fix before orchestrating. Same checks as ' +
  '`npx @chamba/mcp doctor`.';

export function registerDoctor(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Doctor',
      description: DESCRIPTION,
      inputSchema: {},
    },
    async () => {
      const report = await runDoctor({
        fs: services.fs,
        process: services.process,
        cwd: services.cwd,
        homedir: services.homedir,
        obsidianVaultPath: services.obsidianVaultPath,
        obsidianSearchRoots: obsidianSearchRoots(services),
        nodeVersion: process.version,
        resources: services.system.resources(),
      });

      logger.info(
        { tool: TOOL_NAME, ok: report.ok, warn: report.warn, fail: report.fail },
        'doctor',
      );

      return {
        content: [{ type: 'text', text: renderDoctorReport(report) }],
        structuredContent: {
          healthy: report.healthy,
          ok: report.ok,
          warn: report.warn,
          fail: report.fail,
          checks: report.checks,
        } as Record<string, unknown>,
      };
    },
  );
}
