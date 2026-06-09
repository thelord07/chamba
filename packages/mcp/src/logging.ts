import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { destination, type Logger, pino } from 'pino';

/**
 * Build the logger for the MCP server.
 *
 * CRITICAL: an MCP stdio server MUST NOT write anything to stdout except the
 * MCP protocol itself. A stray `console.log` corrupts the JSON-RPC stream and
 * the editor silently drops the connection. So all logging goes to a file in
 * `~/.chamba/logs/mcp-{pid}.log`, never to stdout/stderr.
 */
export function createLogger(): Logger {
  const logDir = join(homedir(), '.chamba', 'logs');
  mkdirSync(logDir, { recursive: true });
  const logPath = join(logDir, `mcp-${process.pid}.log`);

  return pino(
    { level: process.env.CHAMBA_LOG_LEVEL ?? 'info' },
    destination({ dest: logPath, sync: false }),
  );
}
