/**
 * fatal.ts — Shared fatal-error formatting (CHAMBA-014 C2).
 *
 * Exported separately from main.ts so tests can import it without triggering
 * main.ts side-effects (process.argv parsing, server startup, etc.).
 *
 * Never includes headers, tokens, or raw URLs — only the error code and a
 * short message. Runs through redactSecrets as defence-in-depth.
 */

import { ParcheNetworkError, parcheNetworkErrorMessage } from '@chamba/core';
import { redactSecrets } from './parche/binding-ops.js';

/**
 * User-facing text for any error from a parche operation (CHAMBA-014 §4.3): never a bare
 * `fetch failed`. A `ParcheNetworkError` gets the canonical message (host, attempts, code,
 * retry hint); any other error gets its `cause.code`/`cause.message` appended when present.
 * Always redacted (`pch_` tokens) as defence in depth.
 */
export function describeError(err: unknown, opts?: { slug?: string; retryHint?: string }): string {
  if (err instanceof ParcheNetworkError) {
    return redactSecrets(parcheNetworkErrorMessage(err, opts));
  }
  if (!(err instanceof Error)) return redactSecrets(String(err));

  let msg = err.message;
  const cause = err.cause;
  if (cause != null && typeof cause === 'object') {
    const { code, message } = cause as { code?: unknown; message?: unknown };
    const parts: string[] = [];
    if (typeof code === 'string' && code) parts.push(code);
    if (typeof message === 'string' && message && message !== msg) parts.push(message);
    if (parts.length > 0) msg = `${msg} (${parts.join(': ')})`;
  }
  return redactSecrets(msg);
}

/** Text for the last-resort `chamba-mcp fatal:` line. */
export function formatFatal(err: unknown): string {
  return describeError(err);
}
