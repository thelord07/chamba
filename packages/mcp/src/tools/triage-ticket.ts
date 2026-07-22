import { checkTicketCompleteness, renderTicketCompleteness } from '@chamba/core';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Services } from '../services.js';

const TOOL_NAME = 'chamba_triage_ticket';

const DESCRIPTION =
  'Check a support/bug ticket for completeness with programmatic heuristics (NO LLM): ' +
  'flags whether it has reproduction steps, expected-vs-actual, environment, scope, ' +
  'acceptance criteria and severity. Returns { present, missing, questions, ' +
  'enoughToStart, score }. Use it in /triage to surface what the ticket is missing ' +
  'before diagnosing — the questions are ready to paste back to the reporter.';

export function registerTriageTicket(server: McpServer, logger: Logger, _services: Services): void {
  server.registerTool(
    TOOL_NAME,
    {
      title: 'Triage ticket',
      description: DESCRIPTION,
      inputSchema: {
        ticket: z.string().describe('The ticket / bug report text to check for completeness.'),
      },
      outputSchema: {
        present: z.array(z.string()),
        missing: z.array(z.string()),
        questions: z.array(z.string()),
        enoughToStart: z.boolean(),
        score: z.number(),
      },
    },
    async ({ ticket }) => {
      const result = checkTicketCompleteness({ ticket });
      logger.info(
        { tool: TOOL_NAME, present: result.present.length, enoughToStart: result.enoughToStart },
        'ticket triaged',
      );

      const structuredContent = {
        present: result.present,
        missing: result.missing,
        questions: result.questions,
        enoughToStart: result.enoughToStart,
        score: result.score,
      };
      return {
        content: [{ type: 'text', text: renderTicketCompleteness(result) }],
        structuredContent,
      };
    },
  );
}
