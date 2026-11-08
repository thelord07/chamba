import { createInterface } from 'node:readline';
import { renderDoctorReport, runDoctor } from '@chamba/core';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { runMetricsCli } from './cli/metrics.js';
import { runVaultCli } from './cli/vault.js';
import { formatFatal } from './fatal.js';
import { createLogger } from './logging.js';
import { createServer } from './server.js';
import { createNodeServices, obsidianSearchRoots } from './services.js';
import { readPackageVersion } from './version.js';

/**
 * Entry point for the chamba MCP server.
 *
 * Speaks the MCP protocol over stdio. The editor (Cursor, Claude Code, VS Code,
 * etc.) spawns this process and talks to it via stdin/stdout. Everything else
 * — including any logging — must stay off stdout (see logging.ts).
 */
async function main(): Promise<void> {
  // `--version`/`-v` prints the version and exits before any protocol starts.
  const flag = process.argv[2];
  if (flag === '--version' || flag === '-v') {
    process.stdout.write(`${readPackageVersion()}\n`);
    return;
  }

  // `vault` runs CLI subcommands (join, sync, status, leave) and exits.
  if (flag === 'vault') {
    const services = createNodeServices();

    // Build a default readline prompter (replaced in tests)
    const prompt = (question: string): Promise<string> => {
      return new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (answer) => {
          rl.close();
          resolve(answer);
        });
      });
    };

    await runVaultCli(process.argv.slice(3), {
      services,
      stdout: (msg) => process.stdout.write(`${msg}\n`),
      stderr: (msg) => process.stderr.write(`${msg}\n`),
      exit: (code) => process.exit(code),
      prompt,
      isTTY: process.stdin.isTTY ?? false,
    });
    return;
  }

  // `metrics` renders the task metrics table from tasks.jsonl and exits.
  if (flag === 'metrics') {
    const services = createNodeServices();
    await runMetricsCli(process.argv.slice(3), {
      services,
      stdout: (msg) => process.stdout.write(`${msg}\n`),
      stderr: (msg) => process.stderr.write(`${msg}\n`),
      exit: (code) => process.exit(code),
    });
    return;
  }

  // `doctor` runs environment health checks and exits. Safe to write to stdout
  // here: this path never starts the stdio protocol server.
  if (flag === 'doctor') {
    const services = createNodeServices();
    const report = await runDoctor({
      fs: services.fs,
      process: services.process,
      cwd: services.cwd,
      homedir: services.homedir,
      obsidianVaultPath: services.obsidianVaultPath,
      obsidianSearchRoots: obsidianSearchRoots(services),
      nodeVersion: process.version,
      resources: services.system.resources(),
      now: services.clock.now().toISOString(),
    });
    process.stdout.write(`${renderDoctorReport(report)}\n`);
    process.exitCode = report.healthy ? 0 : 1;
    return;
  }

  const logger = createLogger();
  const services = createNodeServices(logger);
  const server = createServer(logger, services);
  const transport = new StdioServerTransport();

  await server.connect(transport);
  logger.info('chamba MCP server connected over stdio');

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    void server.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  // Last-resort error path. stderr is acceptable here because the process is
  // about to die and the transport is not (or no longer) carrying protocol.
  // formatFatal includes cause.code/message when present and redacts pch_ tokens.
  process.stderr.write(`chamba-mcp fatal: ${formatFatal(err)}\n`);
  process.exit(1);
});
