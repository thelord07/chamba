import {
  extractSubtaskPaths,
  inspectRepos,
  joinPath,
  loadConfig,
  type PartitionItem,
  partitionByOverlap,
  WORKSPACE_DIR,
  WorktreeInspector,
} from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_partition';

const DESCRIPTION =
  'Partition work into parallel waves (NO LLM) so overlapping file sets do not ' +
  'run together. Observed paths (from worktrees) can block when failOnOverlap is ' +
  'on; paths predicted from a plan are warnings only.';

const CONFIG_FILE = `${WORKSPACE_DIR}/config.json`;

export function registerPartition(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Partition parallel work',
      description: DESCRIPTION,
      inputSchema: {
        plan: z.string().optional().describe('Plan markdown; extracts "files likely touched".'),
        items: z
          .array(z.object({ id: z.string(), paths: z.array(z.string()) }))
          .optional()
          .describe('Explicit items to partition (wins over plan/worktrees).'),
        fromWorktrees: z
          .boolean()
          .optional()
          .describe('Use observed changed files from git worktrees.'),
        repos: z.array(z.string()).optional(),
      },
    },
    async ({ plan, items, fromWorktrees, repos }) => {
      const { worktrees: cfg } = await loadConfig(services.fs, {
        globalPath: joinPath(services.homedir, CONFIG_FILE),
        projectPath: joinPath(services.cwd, CONFIG_FILE),
      });

      let kind: 'explicit' | 'observed' | 'predicted' = 'explicit';
      let partitionItems: PartitionItem[] = items ?? [];
      if (partitionItems.length === 0 && fromWorktrees) {
        kind = 'observed';
        const inspector = new WorktreeInspector(services.process, services.clock);
        const inspections = await inspectRepos({
          inspector,
          fs: services.fs,
          cwd: services.cwd,
          repos,
          baseBranch: cfg.baseBranch,
        });
        partitionItems = inspections.flatMap((ins) =>
          ins.worktrees
            .filter((w) => !w.primary)
            .map((w) => ({ id: w.branch ?? w.path, paths: w.changedFiles })),
        );
      } else if (partitionItems.length === 0 && plan) {
        kind = 'predicted';
        partitionItems = extractSubtaskPaths(plan);
      }

      const result = partitionByOverlap(partitionItems);
      const blocking =
        kind === 'observed' && cfg.overlap.failOnOverlap && result.overlaps.length > 0;
      const ok = !blocking;

      logger.info(
        { tool: TOOL_NAME, kind, waves: result.waves.length, overlaps: result.overlaps.length, ok },
        'partition',
      );

      const text = renderPartition(kind, result, ok);
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          ok,
          kind,
          failOnOverlap: cfg.overlap.failOnOverlap,
          ...result,
        },
      };
    },
  );
}

function renderPartition(
  kind: string,
  result: ReturnType<typeof partitionByOverlap>,
  ok: boolean,
): string {
  const lines = [
    `Partition (${kind}${kind === 'predicted' ? ', warning only' : ''}): ${result.waves.length} wave(s), max ${result.maxWaveSize} in parallel.`,
  ];
  result.waves.forEach((w, i) => {
    lines.push(`  wave ${i + 1}: ${w.ids.join(', ') || '(empty)'}`);
  });
  for (const o of result.overlaps) {
    lines.push(`  overlap: ${o.a} ∩ ${o.b} → ${o.files.join(', ')}`);
  }
  if (!ok) {
    lines.push('\nFAIL: observed overlap with worktrees.overlap.failOnOverlap. Run sequentially.');
  } else if (result.overlaps.length > 0 && kind === 'predicted') {
    lines.push(
      '\nPredicted overlap from the plan — verify with chamba_worktree_status after edits.',
    );
  } else if (result.overlaps.length > 0) {
    lines.push('\nRun overlapping items in different waves. Never merge automatically.');
  }
  return lines.join('\n');
}
