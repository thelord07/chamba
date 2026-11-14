/**
 * tasks/verify-evidence.ts — CHAMBA-022
 *
 * `tailRing` is the pure ring-buffer logic behind `ProcessPort.run`'s
 * `capture` option: given the chunks a process emitted (already split per
 * stream — NN2: a fixture emits on a single stream to avoid flaky
 * interleaving), keep only the last `lines` lines, capped at `maxBytes`.
 * The adapter (oleada B) drains the real stream through this; it never
 * drives process lifetime — `truncated` is purely informative (B4).
 *
 * `renderVerifyEvidence`/`renderVerifySummaryBlock` turn a (already
 * redacted) tail into the markdown chamba writes to
 * `tareas/<id>/evidencia/<run>/tests-<name>.md` and into the short summary
 * block pasted into `chamba_summarize_to_vault`.
 */

import type { VerifyRun } from './task-doc.js';

export interface TailRingOptions {
  lines: number;
  maxBytes: number;
}

export interface TailRingResult {
  text: string;
  /** True if either the line count or the byte cap discarded content. */
  truncated: boolean;
}

const encoder = new TextEncoder();

/**
 * Keep the last `opts.lines` lines of `chunks` (joined in order), then
 * further trim from the front until the result fits `opts.maxBytes`.
 * Always keeps at least a fragment of the LAST line when there was any
 * output — a fixture whose output exceeds the cap must still see its final
 * line (or the tail end of it) in the evidence.
 */
export function tailRing(chunks: string[], opts: TailRingOptions): TailRingResult {
  const joined = chunks.join('');
  if (joined === '') return { text: '', truncated: false };

  // Split keeping the EOL attached to each line (CRLF or LF, whichever the
  // process used — never normalized away).
  const parts = joined.split(/(?<=\r?\n)/).filter((p) => p.length > 0);
  const linesTruncated = parts.length > opts.lines;
  const keptByLines = linesTruncated ? parts.slice(-opts.lines) : parts;

  let bytes = 0;
  const kept: string[] = [];
  let bytesTruncated = false;
  for (let i = keptByLines.length - 1; i >= 0; i--) {
    const line = keptByLines[i] ?? '';
    const lineBytes = encoder.encode(line).byteLength;
    if (bytes + lineBytes > opts.maxBytes) {
      bytesTruncated = true;
      break;
    }
    bytes += lineBytes;
    kept.unshift(line);
  }

  if (kept.length === 0 && keptByLines.length > 0) {
    const last = keptByLines[keptByLines.length - 1] ?? '';
    kept.push(truncateToBytes(last, opts.maxBytes));
    bytesTruncated = true;
  }

  return { text: kept.join(''), truncated: linesTruncated || bytesTruncated };
}

/** Keep the SUFFIX of `s` (most recent content) that fits in `maxBytes`. */
function truncateToBytes(s: string, maxBytes: number): string {
  if (encoder.encode(s).byteLength <= maxBytes) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = s.slice(s.length - mid);
    if (encoder.encode(candidate).byteLength <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(s.length - lo);
}

export interface VerifyEvidenceInput {
  name: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
  head?: string;
  dirty?: boolean;
  /** Already redacted (`redactSecretValues`) tail text. */
  tail: string;
}

/**
 * Markdown body for `tests-<name>.md`. Header never includes the full argv
 * (only `name`) to avoid leaking local filesystem paths; the fence length is
 * computed from the content so a stray ``` in the output can't close it
 * early.
 */
export function renderVerifyEvidence(input: VerifyEvidenceInput): string {
  const lines: string[] = [];
  lines.push(`# Evidencia de verify: ${input.name}`);
  lines.push('');
  lines.push(`- exit code: ${input.exitCode}`);
  lines.push(`- duración: ${input.durationMs}ms`);
  if (input.timedOut) lines.push('- timeout: sí (el proceso fue terminado)');
  if (input.truncated) lines.push('- truncado: sí (salida recortada por la cota de retención)');
  if (input.head !== undefined) lines.push(`- head: ${input.head}`);
  if (input.dirty !== undefined) lines.push(`- árbol: ${input.dirty ? 'sucio' : 'limpio'}`);
  lines.push('');
  const fence = defensiveFence(input.tail);
  lines.push(fence);
  lines.push(input.tail);
  lines.push(fence);
  return lines.join('\n');
}

function defensiveFence(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((m, s) => Math.max(m, s.length), 0);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Short block for the Cierre/`summarize_to_vault` summary — no raw output. */
export function renderVerifySummaryBlock(run: VerifyRun): string {
  const headPart =
    run.head !== undefined ? ` sobre \`${run.head}\` (${run.dirty ? 'sucio' : 'limpio'})` : '';

  if (run.level === 'reported-by-agent') {
    return `verify: sin comando configurado${headPart} — nivel más débil: reportado por el agente.`;
  }

  const failed = run.commands.filter((c) => c.exitCode !== 0 || c.timedOut);
  const lines = [
    `verify: ${run.commands.length - failed.length}/${run.commands.length} comando(s) OK${headPart}.`,
  ];
  for (const f of failed) {
    lines.push(`- ${f.name}: exit ${f.exitCode}${f.timedOut ? ' (timeout)' : ''}`);
  }
  return lines.join('\n');
}
