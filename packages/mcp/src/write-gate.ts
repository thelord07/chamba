/**
 * write-gate.ts — CHAMBA-021 D-Q1 (owner decision §9): shared write-time
 * secret gate for every chamba write path (summarize_to_vault, save_plan,
 * remember — vault de parche, vault personal y `.chamba/memory`).
 *
 * Scans every field about to be written (title/summary/keywords/content/…)
 * BEFORE anything touches disk. On a hit: no file is created/modified,
 * `isError: true`, and the response lists one `writeBlockedSecretMessage`
 * line per finding — never the value, never an `allow-secret` hint (there is
 * no path yet). The allowlist never applies here (it only exempts the push).
 */

import {
  type HashPort,
  scanWriteFields,
  type WriteField,
  writeBlockedSecretMessage,
} from '@chamba/core';

export interface SecretWriteGateResult {
  blocked: boolean;
  /** Present only when `blocked` is true — one line per finding. */
  text?: string;
}

/**
 * Run the write-time secret scan over every field a tool is about to persist.
 * Each field is scanned on its own (never joined with the others) so a
 * reported line number always matches that field's own text.
 */
export async function secretWriteGate(
  hash: HashPort,
  fields: WriteField[],
): Promise<SecretWriteGateResult> {
  const findings = await scanWriteFields({ hash }, fields);
  if (findings.length === 0) return { blocked: false };
  return {
    blocked: true,
    text: findings.map((f) => writeBlockedSecretMessage(f)).join('\n'),
  };
}
