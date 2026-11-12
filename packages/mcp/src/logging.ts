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
    {
      level: process.env.CHAMBA_LOG_LEVEL ?? 'info',
      // Redact sensitive credential fields so the token never reaches the log file.
      // CHAMBA-021 S9: 'value'/'secret'/'*.value' are defense in depth for any
      // secret-scanner Finding accidentally logged whole — pino's `redact` acts
      // on KEYS, not message text, so the real defense is never logging a value
      // in the first place (Finding has no `value` field) plus the S9 test.
      redact: [
        'token',
        'deviceToken',
        '*.token',
        'headers.authorization',
        'req.headers.authorization',
        'value',
        'secret',
        '*.value',
      ],
    },
    destination({ dest: logPath, sync: false }),
  );
}
