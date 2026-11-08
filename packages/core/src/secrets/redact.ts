/**
 * secrets/redact.ts — replaces detected secret VALUES with a placeholder in
 * free text (CHAMBA-021 S9, defense in depth for error messages/logs).
 *
 * Unlike `scanText`, this touches the raw text (it has to, to redact it) but
 * never returns the original value — only `[secreto:<kind>]` survives.
 * Pure: no Node imports, no IO.
 */

import { matchRules } from './rules.js';

/**
 * Replace every detected secret value in `text` with `[secreto:<kind>]`.
 * Line-oriented (same traversal as `matchRules`) so it's safe to run over
 * multi-line error messages or stack traces.
 */
export function redactSecretValues(text: string): string {
  let result = text;
  for (const m of matchRules(text)) {
    if (m.value.length === 0) continue;
    result = result.split(m.value).join(`[secreto:${m.kind}]`);
  }
  return result;
}
