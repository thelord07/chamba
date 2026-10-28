import { describe, expect, it } from 'vitest';
import { isSyncable } from './sync-filter.js';

describe('isSyncable — allowed files', () => {
  it('allows .md files', () => expect(isSyncable('notes/hello.md')).toBe(true));
  it('allows .png files', () => expect(isSyncable('img/photo.png')).toBe(true));
  it('allows .jpg files', () => expect(isSyncable('img/photo.jpg')).toBe(true));
  it('allows .jpeg files', () => expect(isSyncable('img/photo.jpeg')).toBe(true));
  it('allows .gif files', () => expect(isSyncable('img/anim.gif')).toBe(true));
  it('allows .webp files', () => expect(isSyncable('img/photo.webp')).toBe(true));
  it('allows .svg files', () => expect(isSyncable('diagrams/flow.svg')).toBe(true));
  it('allows .pdf files', () => expect(isSyncable('docs/manual.pdf')).toBe(true));
  it('allows .canvas files', () => expect(isSyncable('canvas/board.canvas')).toBe(true));
  it('allows .base files', () => expect(isSyncable('file.base')).toBe(true));
  it('allows extensions case-insensitively (.MD)', () =>
    expect(isSyncable('README.MD')).toBe(true));
  it('allows .environment.md (not blocked by .env rule)', () => {
    expect(isSyncable('notas/.environment.md')).toBe(true);
  });
});

describe('isSyncable — denied by segment', () => {
  it('denies .DS_Store', () => expect(isSyncable('.DS_Store')).toBe(false));
  it('denies nested .DS_Store', () => expect(isSyncable('a/.DS_Store')).toBe(false));
  it('denies .trash folder', () => expect(isSyncable('.trash/file.md')).toBe(false));
  it('denies .DS_Store and .trash regardless of case', () => {
    expect(isSyncable('a/.ds_store')).toBe(false);
    expect(isSyncable('.Trash/file.md')).toBe(false);
  });
  it('denies .chamba-sync prefix', () => expect(isSyncable('.chamba-sync/state.json')).toBe(false));
  it('denies .chamba-sync sub', () => expect(isSyncable('a/.chamba-sync-extra/x.md')).toBe(false));
  it('denies .Chamba-Sync/x.md (mixed-case, AC4 optional)', () => {
    expect(isSyncable('.Chamba-Sync/x.md')).toBe(false);
  });

  // Decision 5 — narrow .env filter
  it('denies .env segment', () => expect(isSyncable('.env')).toBe(false));
  it('denies .env.local', () => expect(isSyncable('.env.local')).toBe(false));
  it('denies config/.env.production', () =>
    expect(isSyncable('config/.env.production')).toBe(false));
  it('denies .envrc', () => expect(isSyncable('.envrc')).toBe(false));
  it('denies sub/.envrc', () => expect(isSyncable('sub/.envrc')).toBe(false));
  it('denies uppercase .ENV', () => expect(isSyncable('.ENV')).toBe(false));
  it('denies .ENV.LOCAL', () => expect(isSyncable('.ENV.LOCAL')).toBe(false));
  it('denies .ENVRC', () => expect(isSyncable('.ENVRC')).toBe(false));
});

describe('isSyncable — denied by path prefix (.obsidian)', () => {
  it('denies .obsidian/workspace', () => expect(isSyncable('.obsidian/workspace')).toBe(false));
  it('denies .obsidian/workspace.json', () => {
    expect(isSyncable('.obsidian/workspace.json')).toBe(false);
  });
  it('denies .obsidian/cache', () => expect(isSyncable('.obsidian/cache')).toBe(false));
  it('denies .obsidian/cache/file.md', () => {
    expect(isSyncable('.obsidian/cache/file.md')).toBe(false);
  });
});

describe('isSyncable — denied by extension allowlist', () => {
  it('denies .json files', () => expect(isSyncable('config.json')).toBe(false));
  it('denies .ts files', () => expect(isSyncable('script.ts')).toBe(false));
  it('denies .txt files', () => expect(isSyncable('notes.txt')).toBe(false));
  it('denies files with no extension', () => expect(isSyncable('README')).toBe(false));
});
