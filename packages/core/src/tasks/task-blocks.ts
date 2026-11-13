/**
 * tasks/task-blocks.ts — CHAMBA-022
 *
 * Delimited blocks inside a task document (`tareas/<id>.md`). Everything a
 * human writes OUTSIDE a block survives any rewrite chamba does — only the
 * content strictly between the markers is ever replaced.
 *
 * Markers: `<!-- chamba:task:<name>:start -->` / `<!-- chamba:task:<name>:end -->`
 * `name` is a closed enum (never free text) so a stray HTML comment elsewhere
 * in the document can never be mistaken for a chamba block.
 *
 * Pure TypeScript: no `node:` imports, no IO.
 */

export const TASK_BLOCK_NAMES = [
  'request',
  'criteria',
  'checklist',
  'progress',
  'next_step',
  'scope_changes',
  'evidence',
  'close',
] as const;

export type TaskBlockName = (typeof TASK_BLOCK_NAMES)[number];

function startMarker(name: TaskBlockName): string {
  return `<!-- chamba:task:${name}:start -->`;
}

function endMarker(name: TaskBlockName): string {
  return `<!-- chamba:task:${name}:end -->`;
}

/**
 * Read the raw body (without the markers themselves) of block `name` from
 * `md`. Returns `undefined` if the block is absent, or if the markers are
 * malformed (end before start, or missing one of the two).
 */
export function readBlock(md: string, name: TaskBlockName): string | undefined {
  const start = startMarker(name);
  const end = endMarker(name);
  const startIdx = md.indexOf(start);
  if (startIdx === -1) return undefined;
  const bodyStart = startIdx + start.length;
  const endIdx = md.indexOf(end, bodyStart);
  if (endIdx === -1) return undefined;
  let body = md.slice(bodyStart, endIdx);
  // Drop a single leading/trailing newline introduced by the surrounding markers.
  if (body.startsWith('\n')) body = body.slice(1);
  if (body.endsWith('\n')) body = body.slice(0, -1);
  return body;
}

/**
 * Replace the body of block `name` with `body`, preserving everything else
 * in `md` byte-for-byte. If the block does not exist yet, it is appended at
 * the end of the document (NN5: a document missing a section must still be
 * writable — it never becomes impossible to close).
 */
export function upsertBlock(md: string, name: TaskBlockName, body: string): string {
  const start = startMarker(name);
  const end = endMarker(name);
  const rendered = `${start}\n${body}\n${end}`;

  const startIdx = md.indexOf(start);
  if (startIdx === -1) {
    const sep = md.endsWith('\n') || md.length === 0 ? '' : '\n';
    return `${md}${sep}\n${rendered}\n`;
  }
  const bodyStart = startIdx + start.length;
  const endIdx = md.indexOf(end, bodyStart);
  if (endIdx === -1) {
    // Malformed (start without matching end) — treat as absent and append
    // a fresh, well-formed block rather than guessing where to patch.
    const sep = md.endsWith('\n') || md.length === 0 ? '' : '\n';
    return `${md}${sep}\n${rendered}\n`;
  }
  const endOfBlock = endIdx + end.length;
  return `${md.slice(0, startIdx)}${rendered}${md.slice(endOfBlock)}`;
}
