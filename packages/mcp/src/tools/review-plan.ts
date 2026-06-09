import { Reviewer, WorkspaceScanner } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_review_plan';

const DESCRIPTION =
  'Review a plan with programmatic heuristics (NO LLM): checks for acceptance ' +
  'criteria, tests, subtasks with assigned workers, concrete descriptions, files ' +
  'outside the workspace, and risk assessment for sensitive areas. Returns ' +
  '{ approved, issues, suggestions, riskFlags }.';

export function registerReviewPlan(server: McpServer, logger: Logger, services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Review plan',
      description: DESCRIPTION,
      inputSchema: {
        plan: z.string().describe('The plan markdown to review.'),
        task: z.string().describe('The task the plan is for.'),
        context: z.string().optional().describe('Context from chamba_load_context, if any.'),
      },
      outputSchema: {
        approved: z.boolean(),
        issues: z.array(
          z.object({
            code: z.string(),
            severity: z.enum(['error', 'warning']),
            message: z.string(),
          }),
        ),
        suggestions: z.array(z.string()),
        riskFlags: z.array(z.string()),
      },
    },
    async ({ plan, task, context }) => {
      const workspace = await new WorkspaceScanner(services.fs).scan(services.cwd);
      const review = new Reviewer().review({ plan, task, context, workspace });
      logger.info(
        { tool: TOOL_NAME, approved: review.approved, issues: review.issues.length },
        'plan reviewed',
      );

      const verdict = review.approved ? '✅ approved' : '❌ changes requested';
      const errorLines = review.issues.map((i) => `- [${i.severity}] ${i.code}: ${i.message}`);
      const summary = [
        `Plan review: ${verdict}`,
        review.issues.length > 0 ? `\nIssues:\n${errorLines.join('\n')}` : '',
        review.riskFlags.length > 0
          ? `\nRisk flags:\n${review.riskFlags.map((r) => `- ${r}`).join('\n')}`
          : '',
        review.suggestions.length > 0
          ? `\nSuggestions:\n${review.suggestions.map((s) => `- ${s}`).join('\n')}`
          : '',
      ]
        .filter((s) => s.length > 0)
        .join('\n');

      // PlanReview is a closed interface; the SDK wants an index-signature record.
      const structuredContent = review as unknown as Record<string, unknown>;
      return { content: [{ type: 'text', text: summary }], structuredContent };
    },
  );
}
