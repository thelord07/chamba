import type { PartitionItem } from './overlap.js';
import { normalizeGitPath, unique } from './status-files.js';

/**
 * Pull `files likely touched` (and backtick paths on those lines) out of a
 * plan's Subtasks section. Predicted overlap is warning-only — this parser is
 * deliberately conservative so a stray sentence does not look like a path set.
 */
export function extractSubtaskPaths(plan: string): PartitionItem[] {
  const subtasks = sliceSection(plan, 'subtasks');
  if (subtasks.length === 0) return [];

  const items: PartitionItem[] = [];
  let current: { id: string; paths: string[] } | undefined;

  const flush = (): void => {
    if (current) items.push({ id: current.id, paths: unique(current.paths) });
    current = undefined;
  };

  for (const raw of subtasks.split('\n')) {
    const numbered = /^\s*\d+\.\s+\*\*([^*]+)\*\*\s+[—-]\s+(.+)$/.exec(raw);
    if (numbered) {
      flush();
      const worker = numbered[1]?.trim() ?? 'subtask';
      const title = numbered[2]?.trim() ?? '';
      current = { id: `${worker}: ${title}`, paths: [] };
      continue;
    }
    if (!current) continue;
    const touched = /files likely touched:\s*(.*)$/i.exec(raw);
    if (touched) {
      current.paths.push(...splitPathList(touched[1] ?? ''));
    }
  }
  flush();
  return items.filter((i) => i.paths.length > 0);
}

function sliceSection(markdown: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'im');
  const start = markdown.search(re);
  if (start < 0) return '';
  const after = markdown.slice(start);
  const next = after.slice(1).search(/^##\s+/m);
  return next < 0 ? after : after.slice(0, next + 1);
}

function splitPathList(rest: string): string[] {
  const cleaned = rest.replace(/<!--.*?-->/g, '').trim();
  if (cleaned.length === 0 || cleaned === '-') return [];
  const fromTicks = [...cleaned.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? '');
  const raw = fromTicks.length > 0 ? fromTicks : cleaned.split(/[,;]+/);
  return raw
    .map((p) => normalizeGitPath(p.replace(/^[-*]\s*/, '')))
    .filter((p) => p.length > 0 && p !== 'list paths' && looksLikePath(p));
}

function looksLikePath(p: string): boolean {
  if (p.includes('/') || p.includes('\\')) return true;
  return /\.[a-zA-Z0-9]{1,8}$/.test(p);
}
