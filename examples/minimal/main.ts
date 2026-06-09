/**
 * chamba — minimal agent loop, on purpose ugly and direct.
 *
 * No abstractions, no interfaces, no ports. One file. This is the essence of an
 * agent harness before we break it into pieces in the following phases:
 *
 *   REPL  ->  send to Claude  ->  if tool_use: ask human, run tool, feed result
 *                            ->  repeat until end_turn  ->  back to REPL
 *
 * Run it:  ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @chamba/examples-minimal start
 */
import { exec } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';

const execAsync = promisify(exec);

const MODEL = process.env.CHAMBA_MODEL ?? 'claude-sonnet-4-5';
const MAX_TOKENS = 4096;

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY. Set it and try again.');
  process.exit(1);
}

const client = new Anthropic();

// --- The 3 hardcoded tools ----------------------------------------------------

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'bash',
    description: 'Run a shell command in the current directory and return its output.',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'The shell command to run' } },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file and return its contents.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the file to read' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write (overwrite) a UTF-8 text file with the given content.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write' },
        content: { type: 'string', description: 'Full content to write' },
      },
      required: ['path', 'content'],
    },
  },
];

// --- REPL plumbing ------------------------------------------------------------

const rl = createInterface({ input: process.stdin, output: process.stdout });

async function askApproval(toolName: string, input: Record<string, unknown>): Promise<boolean> {
  console.log(`\n  ⚡ tool: ${toolName}`);
  console.log(`     input: ${JSON.stringify(input)}`);
  const answer = (await rl.question('     approve? [y/N] ')).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

// --- Tool execution -----------------------------------------------------------

async function runTool(
  name: string,
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  try {
    if (name === 'bash') {
      const { stdout, stderr } = await execAsync(String(input.command), {
        cwd: process.cwd(),
        timeout: 60_000,
      });
      return { content: stdout || stderr || '(no output)', isError: false };
    }
    if (name === 'read_file') {
      const content = await readFile(String(input.path), 'utf8');
      return { content, isError: false };
    }
    if (name === 'write_file') {
      await writeFile(String(input.path), String(input.content), 'utf8');
      return { content: `Wrote ${String(input.path)}`, isError: false };
    }
    return { content: `Unknown tool: ${name}`, isError: true };
  } catch (err) {
    return { content: `Error: ${(err as Error).message}`, isError: true };
  }
}

// --- The agent loop -----------------------------------------------------------

const SYSTEM_PROMPT =
  'You are chamba, a coding assistant running in a terminal. You have bash, ' +
  'read_file and write_file tools. Use them to inspect and modify the project ' +
  'when the user asks. Keep answers short and concrete.';

async function agentTurn(messages: Anthropic.MessageParam[]): Promise<void> {
  // Keep calling the model until it stops asking for tools.
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages,
      tools: TOOLS,
    });

    // Print any text the model produced this step.
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) {
        console.log(`\nchamba: ${block.text}`);
      }
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return;
    }

    // Execute every tool_use block, collecting results for the next turn.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;

      const input = (block.input ?? {}) as Record<string, unknown>;
      const approved = await askApproval(block.name, input);

      if (!approved) {
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'Denied by the user.',
          is_error: true,
        });
        continue;
      }

      const result = await runTool(block.name, input);
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result.content,
        is_error: result.isError,
      });
    }

    messages.push({ role: 'user', content: toolResults });
  }
}

// --- REPL ---------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('chamba minimal agent. Type your request, or /exit to quit.\n');
  const messages: Anthropic.MessageParam[] = [];

  while (true) {
    const userInput = (await rl.question('you: ')).trim();
    if (!userInput) continue;
    if (userInput === '/exit' || userInput === '/quit') break;

    messages.push({ role: 'user', content: userInput });

    try {
      await agentTurn(messages);
    } catch (err) {
      console.error(`\n[error] ${(err as Error).message}`);
    }
  }

  rl.close();
  console.log('\nchau 👋');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
