import type { ClockPort } from '../ports/clock.js';
import type { FilesystemPort } from '../ports/filesystem.js';
import { joinPath } from '../util/path.js';
import { WORKSPACE_DIR } from '../workspace/workspace.js';
import type { Memory, MemoryStore, RememberInput } from './store.js';

/** Directory (relative to root) where memories live. */
export const MEMORY_DIR = `${WORKSPACE_DIR}/memory`;

/**
 * Filesystem-backed `MemoryStore`. One markdown file per memory under
 * `.chamba/memory/<slug>.md`, with YAML-ish frontmatter (key, tags, createdAt,
 * updatedAt). Re-remembering an existing key appends a timestamped section
 * instead of overwriting. Search is case-insensitive substring over key, tags
 * and content.
 */
export class FilesystemMemoryStore implements MemoryStore {
  constructor(
    private readonly fs: FilesystemPort,
    private readonly clock: ClockPort,
    private readonly root: string,
  ) {}

  private dir(): string {
    return joinPath(this.root, MEMORY_DIR);
  }

  private pathFor(key: string): string {
    return joinPath(this.dir(), `${slugifyKey(key)}.md`);
  }

  async remember(input: RememberInput): Promise<Memory> {
    const path = this.pathFor(input.key);
    const now = this.clock.now().toISOString();
    const existing = await this.read(path);

    let memory: Memory;
    if (existing) {
      memory = {
        key: existing.key,
        tags: [...new Set([...existing.tags, ...(input.tags ?? [])])],
        createdAt: existing.createdAt,
        updatedAt: now,
        content: `${existing.content.trimEnd()}\n\n## Update ${now}\n\n${input.content.trim()}`,
        path,
      };
    } else {
      memory = {
        key: input.key,
        tags: input.tags ?? [],
        createdAt: now,
        updatedAt: now,
        content: input.content.trim(),
        path,
      };
    }

    await this.fs.mkdir(this.dir());
    await this.fs.writeFile(path, render(memory));
    return memory;
  }

  async recall(query: string): Promise<Memory[]> {
    const keywords = query
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 0);
    if (keywords.length === 0) return [];

    let entries: Awaited<ReturnType<FilesystemPort['readDir']>>;
    try {
      entries = await this.fs.readDir(this.dir());
    } catch {
      return [];
    }

    const scored: Array<{ memory: Memory; score: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile || !entry.name.toLowerCase().endsWith('.md')) continue;
      const memory = await this.read(joinPath(this.dir(), entry.name));
      if (!memory) continue;
      const haystack = `${memory.key} ${memory.tags.join(' ')} ${memory.content}`.toLowerCase();
      const score = keywords.filter((k) => haystack.includes(k)).length;
      if (score > 0) scored.push({ memory, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.map((s) => s.memory);
  }

  private async read(path: string): Promise<Memory | null> {
    let text: string;
    try {
      text = await this.fs.readFile(path);
    } catch {
      return null;
    }
    return parse(text, path);
  }
}

// --- markdown <-> Memory ------------------------------------------------------

function slugifyKey(key: string): string {
  const slug = key
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug.length > 0 ? slug : 'memory';
}

function render(memory: Memory): string {
  const frontmatter = [
    '---',
    `key: ${memory.key}`,
    `tags: [${memory.tags.join(', ')}]`,
    `createdAt: ${memory.createdAt}`,
    `updatedAt: ${memory.updatedAt}`,
    '---',
  ].join('\n');
  return `${frontmatter}\n\n${memory.content.trim()}\n`;
}

function parse(text: string, path: string): Memory {
  const fm = text.match(/^---\n([\s\S]*?)\n---\n?/);
  const meta: Record<string, string> = {};
  if (fm?.[1]) {
    for (const line of fm[1].split('\n')) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m?.[1]) meta[m[1]] = (m[2] ?? '').trim();
    }
  }
  const body = fm ? text.slice(fm[0].length) : text;
  const tagsRaw = (meta.tags ?? '').replace(/^\[|\]$/g, '');
  const tags = tagsRaw
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);

  return {
    key: meta.key ?? slugFromPath(path),
    tags,
    createdAt: meta.createdAt ?? '',
    updatedAt: meta.updatedAt ?? meta.createdAt ?? '',
    content: body.trim(),
    path,
  };
}

function slugFromPath(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1);
  return file.replace(/\.md$/, '');
}
