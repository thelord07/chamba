import { describe, expect, it } from 'vitest';
import { MemoryFilesystem } from '../testing/memory-filesystem.js';
import { copyEnvFiles } from './env-copy.js';

const PRUNE = ['node_modules', '.git', 'dist'];

describe('copyEnvFiles', () => {
  it('copies .env and nested .env preserving relative paths', async () => {
    const fs = new MemoryFilesystem({
      '/repo/.env': 'ROOT=1',
      '/repo/temporal/.env': 'NESTED=1',
      '/repo/src/index.ts': 'x',
    });
    const count = await copyEnvFiles(fs, '/repo', '/wt', PRUNE);
    expect(count).toBe(2);
    expect(await fs.readFile('/wt/.env')).toBe('ROOT=1');
    expect(await fs.readFile('/wt/temporal/.env')).toBe('NESTED=1');
  });

  it('copies .env.* but skips examples and backups', async () => {
    const fs = new MemoryFilesystem({
      '/repo/.env.local': 'L=1',
      '/repo/.env.example': 'E=1',
      '/repo/.env.sample': 'S=1',
      '/repo/.env.local.bak': 'B=1',
    });
    const count = await copyEnvFiles(fs, '/repo', '/wt', PRUNE);
    expect(count).toBe(1);
    expect(await fs.exists('/wt/.env.local')).toBe(true);
    expect(await fs.exists('/wt/.env.example')).toBe(false);
    expect(await fs.exists('/wt/.env.sample')).toBe(false);
    expect(await fs.exists('/wt/.env.local.bak')).toBe(false);
  });

  it('prunes heavy dirs', async () => {
    const fs = new MemoryFilesystem({
      '/repo/.env': 'A=1',
      '/repo/node_modules/pkg/.env': 'NOPE=1',
    });
    const count = await copyEnvFiles(fs, '/repo', '/wt', PRUNE);
    expect(count).toBe(1);
    expect(await fs.exists('/wt/node_modules/pkg/.env')).toBe(false);
  });
});
