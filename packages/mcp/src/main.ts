import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderDoctorReport, runDoctor } from '@chamba/core';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLogger } from './logging.js';
import { createServer } from './server.js';
import { createNodeServices, obsidianSearchRoots } from './services.js';

/** Read this package's version from its package.json, next to the built file. */
function readPackageVersion(): string {
  try {
    const pkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

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
    });
    process.stdout.write(`${renderDoctorReport(report)}\n`);
    process.exitCode = report.healthy ? 0 : 1;
    return;
  }

  const logger = createLogger();
  const server = createServer(logger);
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
  process.stderr.write(`chamba-mcp fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
